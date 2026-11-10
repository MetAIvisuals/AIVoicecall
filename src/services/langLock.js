// Decides when the caller's detected language may be trusted.
// One short or garbled utterance (e.g. "Hallo" heard as Japanese) must never set or flip it.
// Votes are collected over the last WINDOW utterances that carry enough text; a language is locked
// in when it has FIRST_LOCK votes (first lock) or SWITCH_AFTER votes (switching) and beats the rest.
const FIRST_LOCK = Number(process.env.LANG_FIRST_LOCK || 2);
const SWITCH_AFTER = Number(process.env.LANG_SWITCH_AFTER || 3);
const WINDOW = 6;

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

// enough text to say anything about the language?
export function enoughEvidence(text) {
  const t = (text || '').trim();
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (CJK.test(t)) return letters >= 4;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= 2 && letters >= 6;
}

// Records one detection on the session; returns true when `lang` should now be locked in.
export function shouldLockLang(session, lang, text) {
  if (!session || !lang || !enoughEvidence(text)) return false;
  const votes = (session.langVotes = [...(session.langVotes || []), lang].slice(-WINDOW));
  const count = (l) => votes.filter((v) => v === l).length;
  if (session.callerLang === lang) return false;
  const rivals = Math.max(0, ...[...new Set(votes)].filter((l) => l !== lang).map(count));
  const need = session.callerLang ? SWITCH_AFTER : FIRST_LOCK;
  if (count(lang) < need || count(lang) <= rivals) return false;
  session.langVotes = [];
  return true;
}
