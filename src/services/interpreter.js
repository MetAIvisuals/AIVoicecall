// Translate one utterance. Strictly literal: never completes, guesses or answers.
const NAMES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', tr: 'Turkish', ar: 'Arabic',
  pl: 'Polish', nl: 'Dutch', hi: 'Hindi', uk: 'Ukrainian',
};
export const langName = (c) => NAMES[c] || c;
export const KNOWN_LANGS = new Set(Object.keys(NAMES));

// Laughter, filler and noise must never reach the TTS — it would read them out like a robot.
const NOISE = /^(?:h+[aeiu]+(?:h+[aeiu]*)*|[aeiou]*h+|l+o+l+|ㅋ+|ㅎ+|哈+|w{3,}|m+h*m+|h+m+|u+h+m*|u+m+|ä+h+m*|e+h+|o+h+|a+h+)$/i;

export function isSpeakable(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const bare = t.replace(/[\s.,!?¿¡…"'`-]/g, '');
  if (!bare) return false;                       // punctuation only
  if (!/\p{L}/u.test(bare)) return false;        // no letters at all
  if (NOISE.test(bare)) return false;            // laughter / filler
  if ((bare.match(/\p{L}/gu) || []).length < 2) return false; // single stray letter
  return true;
}

// Which language is this? Used off the critical path, to point the other leg at the caller's language.
export async function detectLanguage(text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.TRANSLATE_MODEL || 'gpt-4o-mini',
      temperature: 0, max_tokens: 20,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Identify the language of the text. Respond only with JSON: {"lang":"<ISO 639-1 code>"}.' },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error(`detect ${r.status}`);
  const data = await r.json();
  const lang = (JSON.parse(data.choices[0].message.content || '{}').lang || '').toLowerCase().slice(0, 2);
  return KNOWN_LANGS.has(lang) ? lang : null;
}

export async function interpret(text, targetLang) {
  const model = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
  const target = langName(targetLang);
  const system = [
    `You are a simultaneous interpreter on a live phone call. Render the user's utterance in ${target}.`,
    'Translate only. Never answer, reply, comment, greet, apologise or add anything of your own.',
    'Translate exactly what is there, nothing more. Never complete a fragment, never guess what the',
    'speaker probably meant, never correct, polish or expand it, and never invent words they did not say.',
    'Speak as the speaker does: first person, natural spoken language, same tone and register.',
    `If the utterance is already in ${target}, repeat it word for word, unchanged.`,
    'If it is unintelligible, cut off, or only noise, laughter or filler, return an empty text.',
    'Respond only with JSON: {"lang":"<ISO 639-1 code of the utterance>","text":"<translation or empty>"}.',
  ].join('\n');

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
