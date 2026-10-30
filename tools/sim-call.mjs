// railway run --service AIVoicecall -- env TRANSLATOR=gemini node tools/sim-call.mjs
// Two fake Twilio legs with line noise through the real stream handler: callee says "Hallo?", then the caller speaks English.
import { EventEmitter } from 'events';
const R = new URL('../src', import.meta.url).href;
const { handleMediaStream } = await import(`${R}/routes/stream.js`);
const { sessionStore } = await import(`${R}/services/sessionStore.js`);
const { makeDownsampler24to8, mulawEncode, MULAW_DECODE, rms } = await import(`${R}/services/audio.js`);

const pairId = 'SIM1';
sessionStore.set(pairId, { callerLang: null, targetLang: 'de', transcript: [], status: 'active' });
const got = { caller: 0, callee: 0 };
function leg(role) {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = (m) => {
    const p = JSON.parse(m).media?.payload; if (!p) return;
    const b = Buffer.from(p, 'base64');
    if (rms(Int16Array.from(b, (x) => MULAW_DECODE[x])) >= 150) got[role] += b.length;
  };
  handleMediaStream(ws);
  ws.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'S' + role, callSid: 'C' + role, customParameters: { pairId, role } } }));
  return ws;
}
const caller = leg('caller'), callee = leg('callee');
const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hello, I would like to book a table for two people tomorrow evening.', response_format: 'pcm' }) });
const speech = Buffer.from(makeDownsampler24to8()(Buffer.from(await r.arrayBuffer())).map(mulawEncode));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (ws, b) => ws.emit('message', JSON.stringify({ event: 'media', media: { payload: b.toString('base64') } }));
// a real line is never digitally silent
const noise = () => Buffer.from(Array.from({ length: 160 }, () => mulawEncode(Math.round((Math.random() - 0.5) * 2 * 120))));
const tts2 = async (t) => { const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'ash', input: t, response_format: 'pcm' }) });
  return Buffer.from(makeDownsampler24to8()(Buffer.from(await r.arrayBuffer())).map(mulawEncode)); };
const hallo = await tts2('Hallo? Wer ist da?');
await sleep(3000);
// callee answers first, then the caller speaks
const lead = hallo.length + 160 * 150;
const total = lead + speech.length + 160 * 400;
for (let i = 0; i < total; i += 160) {
  frame(callee, i < hallo.length ? hallo.subarray(i, i + 160) : noise());
  const j = i - lead;
  frame(caller, j >= 0 && j < speech.length ? speech.subarray(j, j + 160) : noise());
  await sleep(20);
}
console.log(`audible AI audio played to callee: ${(got.callee / 8000).toFixed(1)} s, to caller: ${(got.caller / 8000).toFixed(1)} s`);
process.exit(0);
