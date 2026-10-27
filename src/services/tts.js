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
      instructions: process.env.TTS_INSTRUCTIONS || [
        'You are interpreting a live phone call between two people.',
        'Speak like a real person talking on the phone: warm, relaxed and conversational,',
        'with natural rhythm, natural intonation and small variations in pace.',
        'Do not sound like an announcer, a news reader or an assistant, and do not over-enunciate.',
        'Match the mood of what is being said, but stay even and easy to understand.',
        'Say only the words given. Never read punctuation, emoji or descriptions out loud.',
      ].join(' '),
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
