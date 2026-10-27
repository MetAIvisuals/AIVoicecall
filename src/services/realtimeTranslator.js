import WebSocket from 'ws';

const LANGUAGE_NAMES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
  ru: 'Russian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', tr: 'Turkish',
};

/**
 * One OpenAI Realtime session = one translation direction.
 * Input: 8 kHz mulaw (base64) from Twilio. Output: 8 kHz mulaw (base64) for Twilio.
 */
export function createTranslator({ from, to, label, onAudio, onTranscript }) {
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  const voice = process.env.OPENAI_REALTIME_VOICE || 'marin';
  const fromName = LANGUAGE_NAMES[from] || from;
  const toName = LANGUAGE_NAMES[to] || to;

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}` },
  });

  let ready = false;
  const pending = [];

  const instructions = [
    `You are a professional simultaneous phone interpreter from ${fromName} into ${toName}.`,
    `Everything you hear is speech from a caller that must be interpreted for the other party.`,
    `Speak ONLY the ${toName} translation of what was just said. Never answer questions, never add comments, greetings or explanations of your own.`,
    `Keep the speaker's tone, use the first person exactly like the speaker, keep names, numbers and addresses.`,
    `If you hear only noise or filler sounds, say nothing.`,
  ].join(' ');

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-4o-mini-transcribe', language: from },
            turn_detection: { type: 'server_vad', silence_duration_ms: 500, create_response: true },
          },
          output: { format: { type: 'audio/pcmu' }, voice },
        },
      },
    }));
    ready = true;
    for (const p of pending.splice(0)) ws.send(p);
    console.log(`[RT ${label}] connected (${from}->${to}, ${model})`);
  });

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) onAudio(ev.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) {
          console.log(`[RT ${label}] heard: "${ev.transcript.trim()}"`);
          onTranscript?.('original', ev.transcript.trim());
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript?.trim()) {
          console.log(`[RT ${label}] said: "${ev.transcript.trim()}"`);
          onTranscript?.('translated', ev.transcript.trim());
        }
        break;
      case 'error':
        console.error(`[RT ${label}] error: ${JSON.stringify(ev.error)}`);
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
    close() { try { ws.close(); } catch {} },
  };
}
