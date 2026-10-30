import WebSocket from 'ws';
import { langName } from './interpreter.js';

/**
 * One speech-to-speech interpreter session per phone leg (OpenAI Realtime API).
 *
 * Replaces the transcriber -> interpreter -> TTS chain: audio goes in as 8 kHz
 * mulaw and comes back as 8 kHz mulaw in one fixed voice, so there is no
 * resampling and no serial round trips.
 *
 * onAudio(Buffer of 8 kHz mulaw) fires as the translated speech arrives.
 */
export function createRealtime({ label, targetLang, language, onAudio, onInputTranscript, onOutputTranscript, onSpeechStopped }) {
  const model = process.env.REALTIME_MODEL || 'gpt-realtime';
  const voice = process.env.TTS_VOICE || 'coral';
  // Measured end of speech -> first AI audio: 500 ms -> ~1.65 s, 350 ms -> ~1.47 s, 200 ms -> ~1.36 s.
// About 1.1 s of that is the server's own transcription and generation, so this wait is the only
// part we control. Lower cuts people off at natural pauses, so 350 is the compromise.
const silenceMs = Number(process.env.VAD_SILENCE_MS || 350);
  const threshold = Number(process.env.VAD_THRESHOLD || 0.6);
  const transcribeModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}` },
  });

  let ready = false;
  let triedBeta = false;
  let target = targetLang;
  // Unpinned, the transcriber hears our own voice echoing back as Korean or Japanese gibberish,
  // which the text echo check cannot match, so the model re-voices the echo as a new sentence.
  let lang = language || null;
  let turnWatchdog = null;
  const pending = [];

  // The two failure modes of a speech-to-speech interpreter are answering instead of
  // translating, and going quiet when nothing needs translating. Both are ruled out here.
  function instructions() {
    const to = langName(target);
    return [
      `You are the voice of a simultaneous interpreter on a live phone call. Everything you hear is one person speaking, and it has to reach the other person in ${to}.`,
      `Always say the utterance in ${to}, in the first person, as if you were that person.`,
      `If it is already in ${to}, say it again in ${to} anyway, as close to word for word as possible. Never go silent just because no translation seems necessary.`,
      'Never answer, reply, comment, greet, explain or ask anything. You are not taking part in the conversation and you are not an assistant. You only re-voice what was said.',
      'Never add words the speaker did not say, and never complete, correct or guess at a fragment. Say only what is there.',
      'Speak the way people speak on the phone: warm, relaxed, natural rhythm. Do not read punctuation out loud.',
      'If you hear only noise, laughter or filler, stay silent.',
      // Without this it fills an unclear word with a whole plausible sentence: a test fed it one
      // muffled word and got back "Also, ich bin jetzt auf dem Gipfel." Spelling out that silence
      // is an acceptable answer stops that and leaves clean sentences untouched.
      'You only ever hear part of a noisy phone line, so being unsure is normal and expected.',
      'If you did not clearly catch what was said, if you only caught a fragment or a single unclear word, or if it would be a guess, say nothing at all. Silence is always the right answer then.',
      'Never fill a gap with something plausible. Never turn a fragment into a whole sentence. Saying nothing is far better than saying something that was not said.',
    ].join(' ');
  }

  function sendGa() {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: instructions(),
        // reasoning models (gpt-realtime-2) think before speaking; the lowest effort is the fastest
        ...(process.env.REALTIME_REASONING ? { reasoning: { effort: process.env.REALTIME_REASONING } } : {}),
        audio: {
          input: {
            format: { type: 'audio/pcmu' }, // mulaw 8 kHz, fixed rate — sending `rate` is rejected
            transcription: { model: transcribeModel, ...(lang ? { language: lang } : {}) },
            noise_reduction: { type: 'near_field' },
            // VAD cuts the turns, but it must not answer by itself: the response is created
            // once the transcript has been checked for echo and junk
            turn_detection: { type: 'server_vad', threshold, prefix_padding_ms: 300, silence_duration_ms: silenceMs, create_response: false },
          },
          output: { format: { type: 'audio/pcmu' }, voice },
        },
      },
    }));
  }

  function sendBeta() {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: instructions(),
        voice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: transcribeModel, ...(lang ? { language: lang } : {}) },
        turn_detection: { type: 'server_vad', threshold, prefix_padding_ms: 300, silence_duration_ms: silenceMs, create_response: false },
      },
    }));
  }

  const update = () => (triedBeta ? sendBeta() : sendGa());

  ws.on('open', () => {
    sendGa();
    ready = true;
    for (const p of pending.splice(0)) ws.send(p);
    console.log(`[RT ${label}] connected (${model}, voice ${voice}, -> ${target})`);
  });

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'input_audio_buffer.speech_stopped':
        onSpeechStopped?.();
        // nothing is spoken without a transcript, so a missing one would silence the call
        clearTimeout(turnWatchdog);
        turnWatchdog = setTimeout(() => console.error(`[RT ${label}] a finished turn produced no transcript — nothing was said`), 5000);
        break;
      // GA and beta spell the audio delta differently; accept both
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) onAudio(Buffer.from(ev.delta, 'base64'));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        clearTimeout(turnWatchdog);
        onInputTranscript?.((ev.transcript || '').trim(), (ev.language || '').toLowerCase().slice(0, 2) || null);
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        onOutputTranscript?.((ev.transcript || '').trim());
        break;
      case 'error':
        console.error(`[RT ${label}] error: ${JSON.stringify(ev.error)}`);
        // older API shape: retry once with the beta session format
        if (!triedBeta && /session|param|unknown|format|modalit/i.test(JSON.stringify(ev.error))) { triedBeta = true; sendBeta(); }
        break;
    }
  });

  ws.on('close', (code, reason) => console.log(`[RT ${label}] closed ${code} ${reason || ''}`));
  ws.on('error', (err) => console.error(`[RT ${label}] ws error: ${err.message}`));

  return {
    sendAudio(base64Mulaw) {
      const msg = JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Mulaw });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (pending.length < 500) pending.push(msg);
    },
    // say the turn that was just committed — called only once its transcript passed the checks
    respond() {
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response.create' }));
    },
    // the caller's language is only known once they have spoken, so the other leg retargets
    setTargetLang(code) {
      if (!code || code === target) return;
      target = code;
      if (ready && ws.readyState === WebSocket.OPEN) { update(); console.log(`[RT ${label}] target -> ${target}`); }
    },
    // pin the transcript to the language this leg speaks, once it is known
    setLanguage(code) {
      if (!code || code === lang) return;
      lang = code;
      if (ready && ws.readyState === WebSocket.OPEN) update();
    },
    close() { clearTimeout(turnWatchdog); try { ws.close(); } catch {} },
  };
}
