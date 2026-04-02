import OpenAI from 'openai';

let _openai = null;
function getClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const LANGUAGE_NAMES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
  ru: 'Russian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese',
};

/**
 * Translates text from sourceLang to targetLang using GPT-4o-mini.
 * We use a prompt that preserves tone (formal/informal) and produces
 * natural spoken output, not written text — important for TTS quality.
 */
export async function translateText(text, sourceLang, targetLang) {
  if (sourceLang === targetLang) return text;

  const fromName = LANGUAGE_NAMES[sourceLang] || sourceLang;
  const toName = LANGUAGE_NAMES[targetLang] || targetLang;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: [
          `You are a professional phone call interpreter translating from ${fromName} to ${toName}.`,
          `Rules:`,
          `- Translate ONLY. Output the translation and nothing else.`,
          `- Preserve the speaker's tone (formal/informal, urgent/calm).`,
          `- Output natural spoken language, not written language.`,
          `- Keep proper nouns, numbers, and addresses as-is.`,
          `- If the input is a single filler word (uh, um, hmm), return the ${toName} equivalent filler.`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: text,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}
