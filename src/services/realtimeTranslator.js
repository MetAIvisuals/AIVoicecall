import WebSocket from 'ws';

// Languages gpt-realtime-translate can speak (output). Input language is detected automatically.
export const LANGUAGES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese',
};

// ---------- audio conversion: Twilio 8 kHz mulaw <-> OpenAI 24 kHz PCM16 ----------
export const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

export function mulawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function makeUpsampler() {
  let prev = 0;
  return (mulaw) => {
    const out = Buffer.alloc(mulaw.length * 6); // 3 samples * 2 bytes
    for (let i = 0; i < mulaw.length; i++) {
      const cur = MULAW_DECODE[mulaw[i]];
      const d = cur - prev;
      out.writeInt16LE(Math.round(prev + d / 3), i * 6);
      out.writeInt16LE(Math.round(prev + (2 * d) / 3), i * 6 + 2);
      out.writeInt16LE(cur, i * 6 + 4);
      prev = cur;
    }
    return out;
  };
}

function makeDownsampler() {
  let rest = Buffer.alloc(0);
  return (pcm24) => {
    const buf = rest.length ? Buffer.concat([rest, pcm24]) : pcm24;
    const frames = Math.floor(buf.length / 6);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = Math.round((buf.readInt16LE(i * 6) + buf.readInt16LE(i * 6 + 2) + buf.readInt16LE(i * 6 + 4)) / 3);
    }
    rest = buf.subarray(frames * 6);
    return out;
  };
}

/**
 * One gpt-realtime-translate session = one direction (one speaker -> one target language).
 * sendAudio(): base64 mulaw from Twilio. onAudio(): Int16Array of 8 kHz PCM samples.
 */
export function createTranslator({ to, label, onAudio, onTranscript }) {
  const model = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-realtime-translate';
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime/translations?model=${model}`, {
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}` },
  });

  const up = makeUpsampler();
  const down = makeDownsampler();
  let ready = false;
  const pending = [];
  const text = { original: '', translated: '' };

  function flushText(kind, force = false) {
    const t = text[kind].trim();
    if (t && (force || /[.?!。？！]$/.test(t))) {
      console.log(`[RT ${label}] ${kind}: "${t}"`);
      onTranscript?.(kind, t);
      text[kind] = '';
    }
  }

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
            noise_reduction: { type: 'near_field' },
          },
          output: { language: to },
        },
      },
    }));
    ready = true;
    for (const p of pending.splice(0)) ws.send(p);
    console.log(`[RT ${label}] connected (-> ${to}, ${model})`);
  });

  ws.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'session.output_audio.delta': {
        if (!ev.delta) break;
        const pcm8 = down(Buffer.from(ev.delta, 'base64'));
        if (pcm8.length) onAudio(pcm8);
        break;
      }
      case 'session.input_transcript.delta':
        text.original += ev.delta || '';
        flushText('original');
        break;
      case 'session.output_transcript.delta':
        text.translated += ev.delta || '';
        flushText('translated');
        break;
      case 'error':
        console.error(`[RT ${label}] error: ${JSON.stringify(ev.error)}`);
        break;
    }
  });

  ws.on('close', (code, reason) => {
    flushText('original', true);
    flushText('translated', true);
    console.log(`[RT ${label}] closed ${code} ${reason || ''}`);
  });
  ws.on('error', (err) => console.error(`[RT ${label}] ws error: ${err.message}`));

  return {
    sendAudio(base64Mulaw) {
      const pcm = up(Buffer.from(base64Mulaw, 'base64'));
      const msg = JSON.stringify({ type: 'session.input_audio_buffer.append', audio: pcm.toString('base64') });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (pending.length < 500) pending.push(msg);
    },
    close() {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.close' }));
        setTimeout(() => { try { ws.close(); } catch {} }, 3000);
      } catch {}
    },
  };
}
