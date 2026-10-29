// Test bench for the Gemini path, no phone needed: synthetic speech goes in as 8 kHz mulaw
// at real-time pace, exactly as Twilio delivers it, and the timings come out.
//   railway run --service AIVoicecall node tools/gemini-bench.mjs [targetLang]
import { createGemini } from '../src/services/gemini.js';
import { makeDownsampler24to8, mulawEncode, MULAW_DECODE, rms } from '../src/services/audio.js';

const target = process.argv[2] || 'de';
const SENTENCES = [
  'Hello, can you hear me?',
  'I would like to book a table for two people tomorrow evening at eight.',
  'Is somebody speaking?',
  'Guten Tag, ich rufe wegen meiner Bestellung an.', // already German: should be echoed when target is de
];

async function tts(text) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  const pcm8 = makeDownsampler24to8()(Buffer.from(await r.arrayBuffer()));
  return Buffer.from(pcm8.map(mulawEncode));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = null;
const gem = createGemini({
  label: 'bench',
  targetLang: target,
  onAudio: (buf) => {
    if (!turn) return;
    turn.bytes += buf.length;
    // the model streams silence as audio too, so only audible chunks count
    if (rms(Int16Array.from(buf, (b) => MULAW_DECODE[b])) < 150) return;
    const now = Date.now();
    if (!turn.first) turn.first = now;
    turn.last = now;
    turn.voiced += buf.length;
  },
  onInputTranscript: (t) => { if (turn) turn.heard += t; },
  onOutputTranscript: (t) => { if (turn) turn.said += t; },
});

const SILENCE = Buffer.alloc(160, 0xff).toString('base64');
await sleep(3000); // let the session set up
for (const text of SENTENCES) {
  const mulaw = await tts(text);
  turn = { start: Date.now(), first: 0, last: 0, bytes: 0, voiced: 0, heard: '', said: '' };
  for (let i = 0; i < mulaw.length; i += 160) {
    gem.sendAudio(mulaw.subarray(i, i + 160).toString('base64'));
    await sleep(20);
  }
  const end = Date.now();
  for (let i = 0; i < 300; i++) { gem.sendAudio(SILENCE); await sleep(20); } // 6 s of line silence
  const t = turn;
  console.log(`\n"${text}" (${end - t.start} ms of speech)`);
  console.log(`  heard: "${t.heard.trim()}"`);
  console.log(`  said:  "${t.said.trim()}" (${(t.voiced / 8000).toFixed(1)} s audible of ${(t.bytes / 8000).toFixed(1)} s received)`);
  console.log(t.first
    ? `  first AI voice ${t.first - t.start} ms after start of speech, AI voice ends ${t.last - end} ms after the speaker stopped`
    : '  no audio came back');
}
gem.close();
process.exit(0);
