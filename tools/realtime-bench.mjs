// Test bench for the OpenAI Realtime path, no phone needed: synthetic speech goes in as 8 kHz
// mulaw at real-time pace, the response is requested once the transcript is in (as in the call),
// and the time from end of speech to the first audible AI voice comes out.
//   railway run --service AIVoicecall -- env REALTIME_MODEL=gpt-realtime-2 node tools/realtime-bench.mjs
import { createRealtime } from '../src/services/realtime.js';
import { makeDownsampler24to8, mulawEncode, MULAW_DECODE, rms } from '../src/services/audio.js';

const SENTENCES = [
  'Hello, can you hear me?',
  'I would like to book a table for two people tomorrow evening at eight.',
  'Is somebody speaking?',
  'pique', // one unclear word: must not turn into an invented sentence
];

async function tts(text) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}`);
  return Buffer.from(makeDownsampler24to8()(Buffer.from(await r.arrayBuffer())).map(mulawEncode));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turn = null;
const rt = createRealtime({
  label: 'bench',
  targetLang: 'de',
  onAudio: (buf) => {
    if (!turn || turn.first || rms(Int16Array.from(buf, (b) => MULAW_DECODE[b])) < 150) return;
    turn.first = Date.now();
  },
  onSpeechStopped: () => { if (turn) turn.stopped = Date.now(); },
  onInputTranscript: (text) => { if (turn) { turn.heard = text; turn.text = Date.now(); } if (text) rt.respond(); },
  onOutputTranscript: (text) => { if (turn) turn.said = text; },
});

const SILENCE = Buffer.alloc(160, 0xff).toString('base64');
await sleep(2000);
const lat = [];
for (const text of SENTENCES) {
  const mulaw = await tts(text);
  turn = { end: 0, stopped: 0, text: 0, first: 0, heard: '', said: '' };
  for (let i = 0; i < mulaw.length; i += 160) { rt.sendAudio(mulaw.subarray(i, i + 160).toString('base64')); await sleep(20); }
  turn.end = Date.now();
  for (let i = 0; i < 300; i++) { rt.sendAudio(SILENCE); await sleep(20); }
  const t = turn;
  console.log(`\n"${text}"\n  heard: "${t.heard}"\n  said:  "${t.said}"`);
  if (t.first) {
    lat.push(t.first - t.end);
    console.log(`  end of speech -> VAD ${t.stopped - t.end} ms, text ${t.text - t.end} ms, AI voice ${t.first - t.end} ms`);
  } else console.log('  no audio came back');
}
console.log(`\n${process.env.REALTIME_MODEL || 'gpt-realtime'} ${process.env.REALTIME_REASONING || ''}: AI voice after end of speech ${lat.join(', ')} ms`);
rt.close();
process.exit(0);
