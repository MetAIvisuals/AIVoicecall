import WebSocket from 'ws';
import { makeUpsampler8to16, makeDownsampler24to8, mulawEncode } from './audio.js';

/**
 * One simultaneous interpreter session per phone leg (Gemini Live Translate).
 *
 * Unlike the OpenAI paths this does not wait for the end of a sentence: the model keeps
 * translating while the person is still speaking, in a copy of their own voice.
 * Audio goes in as 8 kHz mulaw (upsampled to 16 kHz PCM) and comes back as 24 kHz PCM,
 * which is turned back into 8 kHz mulaw here.
 *
 * onAudio(Buffer of 8 kHz mulaw) fires as the translated speech arrives.
 */
const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const CHUNK_BYTES = 3200; // 100 ms of 16 kHz PCM16, the chunk size the docs ask for

// our menu codes -> the BCP-47 codes the model accepts where they differ
const BCP47 = { zh: 'zh-Hans', pt: 'pt-BR' };

export function createGemini({ label, targetLang, onAudio, onInputTranscript, onOutputTranscript }) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-live-translate-preview';
  const key = (process.env.GEMINI_API_KEY || '').trim();

  let ws = null;
  let ready = false;
  let closed = false;
  let target = targetLang;
  let pcm = Buffer.alloc(0);
  const up = makeUpsampler8to16();
  const down = makeDownsampler24to8();

  function setup() {
    const translationConfig = { targetLanguageCode: BCP47[target] || target, echoTargetLanguage: true };
    // translationConfig belongs in generationConfig — at the top of setup the API rejects it
    return { setup: { model: `models/${model}`, generationConfig: { responseModalities: ['AUDIO'], translationConfig }, inputAudioTranscription: {}, outputAudioTranscription: {} } };
  }

  function connect() {
    ready = false;
    let accepted = false;
    const sock = new WebSocket(`${URL}?key=${encodeURIComponent(key)}`);
    ws = sock;

    sock.on('open', () => sock.send(JSON.stringify(setup())));

    sock.on('message', (raw) => {
      let ev;
      try { ev = JSON.parse(raw); } catch { return; }
      if (ev.setupComplete) {
        accepted = true;
        if (sock !== ws) return;
        ready = true;
        console.log(`[GEM ${label}] connected (${model}, -> ${target})`);
        return;
      }
      const sc = ev.serverContent;
      if (sc) {
        for (const part of sc.modelTurn?.parts || []) {
          const d = part.inlineData;
          if (!d?.data || !/audio/.test(d.mimeType || 'audio')) continue;
          const pcm8 = down(Buffer.from(d.data, 'base64'));
          const out = Buffer.alloc(pcm8.length);
          for (let i = 0; i < pcm8.length; i++) out[i] = mulawEncode(pcm8[i]);
          if (out.length) onAudio(out);
        }
        if (sc.inputTranscription?.text) onInputTranscript?.(sc.inputTranscription.text);
        if (sc.outputTranscription?.text) onOutputTranscript?.(sc.outputTranscription.text);
      }
      // the server ends long connections; open the next one before this one goes
      if (ev.goAway) { console.log(`[GEM ${label}] goAway, reconnecting`); reconnect(); }
    });

    sock.on('close', (code, reason) => {
      const why = String(reason || '');
      console.log(`[GEM ${label}] closed ${code} ${why}`);
      if (closed || sock !== ws) return; // ended on purpose, or replaced by a newer session
      if (!accepted) return console.error(`[GEM ${label}] setup rejected — no translation on this leg`);
      setTimeout(() => !closed && sock === ws && connect(), 200); // dropped mid-call: carry on
    });
    sock.on('error', (err) => console.error(`[GEM ${label}] ws error: ${err.message}`));
  }

  function reconnect() {
    const old = ws;
    connect();
    // the old one keeps delivering what it already translated for a moment
    setTimeout(() => { try { old.close(); } catch {} }, 1000);
  }

  if (!key) console.error(`[GEM ${label}] GEMINI_API_KEY is not set`);
  else connect();

  return {
    sendAudio(base64Mulaw) {
      pcm = Buffer.concat([pcm, up(Buffer.from(base64Mulaw, 'base64'))]);
      if (pcm.length < CHUNK_BYTES) return;
      const chunk = pcm;
      pcm = Buffer.alloc(0);
      // before setup completes audio is dropped: it would only arrive late, and lag is the point
      if (!ready || ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: chunk.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    },
    // the target language is part of the session setup, so changing it means a new session
    setTargetLang(code) {
      if (!code || code === target) return;
      target = code;
      if (ws) { console.log(`[GEM ${label}] target -> ${target}`); reconnect(); }
    },
    close() { closed = true; try { ws?.close(); } catch {} },
  };
}
