// Detect language + translate one utterance (text). Same-language text comes back unchanged.
const NAMES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', tr: 'Turkish', ar: 'Arabic',
  pl: 'Polish', nl: 'Dutch', hi: 'Hindi', uk: 'Ukrainian',
};
export const langName = (c) => NAMES[c] || c;

export async function interpret(text, targetLang, context = []) {
  const model = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
  const system = [
    `You are a phone interpreter. Detect the language of the user's utterance and render it in ${langName(targetLang)}.`,
    `If it is already in ${langName(targetLang)}, return it unchanged (only fix obvious transcription errors).`,
    'Translate faithfully in the first person, as natural spoken language. Never answer, comment, greet or add anything.',
    'Respond only with JSON: {"lang":"<ISO 639-1 code of the utterance>","text":"<rendered text>"}.',
    context.length ? `Earlier in this call (for context only):\n${context.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error(`translate ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const out = JSON.parse(data.choices[0].message.content || '{}');
  return { lang: (out.lang || '').toLowerCase().slice(0, 2), text: (out.text || '').trim() };
}
