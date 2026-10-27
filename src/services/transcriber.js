import WebSocket from 'ws';

/**
 * Streaming speech-to-text for one phone leg (OpenAI Realtime transcription session).
 * Input: base64 8 kHz mulaw straight from Twilio. Server VAD cuts utterances.
 * A known `language` is passed to the model — without it short utterances get
 * mis-detected (laughter came back as Korean) and accuracy drops noticeably.
 * onUtterance(text, language) fires once per finished utterance.
 */
export function createTranscriber({ label, language, onUtterance, onSpeechStart, onSpeechStopped }) {
  const model = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
  const silenceMs = Number(process.env.VAD_SILENCE_MS || 500);
  const threshold = Number(process.env.VAD_THRESHOLD || 0.6);
  const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}` },
  });

  let ready = false;
  let triedBeta = false;
  let lang = language || null;
  const pending = [];

  function sendGa() {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model, ...(lang ? { language: lang } : {}) },
            noise_reduction: { type: 'near_field' },
            turn_detection: { type: 'server_vad', threshold, prefix_padding_ms: 300, silence_duration_ms: silenceMs },
          },
        },
      },
    }));
  }

  function sendBeta() {
    ws.send(JSON.stringify({
      type: 'transcription_session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model, ...(lang ? { language: lang } : {}) },
        input_audio_noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold, prefix_padding_ms: 300, silence_duration_ms: silenceMs },
      },
    }));
  }

  const update = () => (triedBeta ? sendBeta() : sendGa());

  ws.on('open', () => {
    sendGa();
    ready = true;
    for (const p of pending.splice(0)) ws.send(p);
    console.log(`[STT ${label}] connected (${model}${lang ? `, ${lang}` : ', auto'})`);
  });

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        onSpeechStart?.();
        break;
      case 'input_audio_buffer.speech_stopped':
        onSpeechStopped?.();
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (ev.transcript || '').trim();
        if (text) onUtterance(text, (ev.language || lang || '').toLowerCase().slice(0, 2) || null);
        break;
      }
      case 'error':
        console.error(`[STT ${label}] error: ${JSON.stringify(ev.error)}`);
        // older API shape: retry once with the beta session format
        if (!triedBeta && /session|param|unknown/i.test(JSON.stringify(ev.error))) { triedBeta = true; sendBeta(); }
        break;
    }
  });

  ws.on('close', (code, reason) => console.log(`[STT ${label}] closed ${code} ${reason || ''}`));
  ws.on('error', (err) => console.error(`[STT ${label}] ws error: ${err.message}`));

  return {
    sendAudio(base64Mulaw) {
      const msg = JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Mulaw });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (pending.length < 500) pending.push(msg);
    },
    // once we know what this person speaks, pin the model to it
    setLanguage(code) {
      if (!code || code === lang) return;
      lang = code;
      if (ready && ws.readyState === WebSocket.OPEN) { update(); console.log(`[STT ${label}] language -> ${lang}`); }
    },
    close() { try { ws.close(); } catch {} },
  };
}
