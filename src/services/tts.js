import { makeDownsampler24to8 } from './audio.js';

/**
 * Streams speech for `text` with one fixed voice. Calls onPcm(Int16Array @ 8 kHz) as audio arrives.
 */
export async function speak(text, onPcm) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.TTS_VOICE || 'coral',
      input: text,
      instructions: 'Calm, clear, friendly phone interpreter. Natural pace.',
      response_format: 'pcm', // 24 kHz 16-bit mono
    }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const down = makeDownsampler24to8();
  for await (const chunk of r.body) {
    const pcm = down(Buffer.from(chunk));
    if (pcm.length) onPcm(pcm);
  }
}
