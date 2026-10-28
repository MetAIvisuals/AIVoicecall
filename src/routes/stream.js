import { createTranscriber } from '../services/transcriber.js';
import { createRealtime } from '../services/realtime.js';
import { createGemini } from '../services/gemini.js';
import { interpret, isSpeakable, detectLanguage, KNOWN_LANGS } from '../services/interpreter.js';
import { speak } from '../services/tts.js';
import { MULAW_DECODE, mulawEncode, rms } from '../services/audio.js';
import { sessionStore } from '../services/sessionStore.js';
import { hangupCall } from '../services/twilioClient.js';

/**
 * Each call leg (caller A, callee B) has its own bidirectional Twilio stream.
 * Per leg: speech -> transcriber -> interpret (detect language + translate, same language stays)
 *          -> TTS with one fixed voice -> queued for the OTHER leg.
 * The other side never hears the original voice, only the AI voice.
 * The caller's language is detected from what they say; the callee's language comes from the menu.
 */
const pairs = new Map();

const GATE_RMS = Number(process.env.NOISE_GATE_RMS || 250);   // quieter frames are sent to STT as silence
const GATE_HOLD_MS = 600;
const MAX_BACKLOG_MS = Number(process.env.MAX_BACKLOG_MS || 4000);
// while the AI voice plays into a leg it can echo back on that leg's mic; keep the tail short
// so speech that starts right after the translation is not swallowed
const ECHO_TAIL_MS = Number(process.env.ECHO_TAIL_MS || 300);
// Muting the mic alone does not stop the loop: the AI voice we play into a leg comes back on
// that leg's mic a little later and gets translated again. So remember what we said into each
// leg for a few seconds and drop a transcript from that leg that matches it.
const ECHO_MEMORY_MS = Number(process.env.ECHO_MEMORY_MS || 8000);
const normalise = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

// Remembered on BOTH legs: a leg hears the AI voice we play into it as echo, and when the two
// phones are within earshot of each other it also hears what the other one plays.
function noteSpoken(pair, text) {
  const n = normalise(text);
  if (!n) return;
  const at = Date.now();
  for (const leg of [pair.caller, pair.callee]) leg?.spoken.push({ n, at });
}

function isEcho(leg, text) {
  const n = normalise(text);
  if (!n) return false;
  const cutoff = Date.now() - ECHO_MEMORY_MS;
  leg.spoken = leg.spoken.filter((s) => s.at > cutoff);
  return leg.spoken.some((s) => s.n === n || (n.length >= 4 && (s.n.includes(n) || n.includes(s.n))));
}
const SILENT_RMS = 150;
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString('base64');
// REALTIME=1 switches to one speech-to-speech session per leg instead of STT -> LLM -> TTS
const USE_REALTIME = /^(1|true|yes|on)$/i.test(process.env.REALTIME || '');
// TRANSLATOR=gemini: simultaneous translation in the speaker's own voice, no waiting for the end of a sentence
const USE_GEMINI = (process.env.TRANSLATOR || '').toLowerCase() === 'gemini';

function newLeg() {
  return { ws: null, streamSid: null, callSid: null, rt: null, spoken: [], out: [], outLen: 0, gateOpenUntil: 0, echoHoldUntil: 0, speechStoppedAt: 0, speechStartedAt: 0, chain: Promise.resolve() };
}

const decodeMulaw = (mulaw) => {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = MULAW_DECODE[mulaw[i]];
  return out;
};

// The queue holds mulaw bytes, ready to hand to Twilio: the Realtime API delivers them that
// way already, and converting the TTS path here keeps the 20 ms pump free of per-sample work.
function enqueueMulaw(leg, buf, silent = false) {
  leg.out.push({ buf, silent });
  leg.outLen += buf.length;
  if (leg.outLen > MAX_BACKLOG_MS * 8) { // falling behind: drop near-silent chunks
    leg.out = leg.out.filter((c, i) => {
      if (i > 0 && c.silent) { leg.outLen -= c.buf.length; return false; }
      return true;
    });
  }
}

function enqueuePcm(leg, pcm) {
  const buf = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) buf[i] = mulawEncode(pcm[i]);
  enqueueMulaw(leg, buf, rms(pcm) < SILENT_RMS);
}

// called on every 20 ms frame received from a leg: send that leg one frame of its pending AI audio
function pump(leg, n) {
  if (!leg.outLen || leg.ws?.readyState !== 1 || !leg.streamSid) return;
  const frame = Buffer.alloc(n, 0xff);
  let filled = 0;
  while (filled < n && leg.out.length) {
    const c = leg.out[0];
    const k = Math.min(n - filled, c.buf.length);
    c.buf.copy(frame, filled, 0, k);
    filled += k;
    if (k === c.buf.length) leg.out.shift(); else c.buf = c.buf.subarray(k);
    leg.outLen -= k;
  }
  leg.ws.send(JSON.stringify({ event: 'media', streamSid: leg.streamSid, media: { payload: frame.toString('base64') } }));
  leg.echoHoldUntil = Date.now() + ECHO_TAIL_MS;
}

function addTranscript(pairId, speaker, kind, text) {
  const session = sessionStore.get(pairId);
  if (session) session.transcript.push({ timestamp: new Date().toISOString(), speaker, kind, text });
}

export function handleMediaStream(ws) {
  let pairId = null;
  let role = null;
  let otherRole = null;
  let stt = null;
  let rt = null;
  let gem = null;

  function targetLangFor(session) {
    if (role === 'caller') return session?.targetLang || process.env.TARGET_LANG || 'de';
    return session?.callerLang || process.env.CALLER_LANG || 'en'; // detected from the caller's speech
  }

  // the caller's language is detected from their speech; a single odd detection must not flip it
  function noteCallerLang(session, lang) {
    if (role !== 'caller' || !session || !lang || !KNOWN_LANGS.has(lang) || session.callerLang === lang) return;
    if (!session.callerLang || session.langCandidate === lang) {
      session.callerLang = lang;
      session.langCandidate = null;
      console.log(`[LANG] caller speaks ${lang}`);
      stt?.setLanguage(lang); // pin this leg's STT to it
      // the other leg translates into the caller's language, so point it there
      pairs.get(pairId)?.[otherRole]?.rt?.setTargetLang(lang);
    } else {
      session.langCandidate = lang; // needs a second utterance to confirm
    }
  }

  // Speech-to-speech path: the model does transcribe, translate and speak in one session,
  // so this side only forwards audio and hands the result to the other leg.
  function startRealtime(leg, session) {
    let firstAudioAt = 0;
    let transcriptAt = 0;
    rt = createRealtime({
      label: role,
      targetLang: targetLangFor(session),
      onAudio: (mulaw) => {
        const other = pairs.get(pairId)?.[otherRole];
        if (!other) return;
        if (!firstAudioAt) {
          firstAudioAt = Date.now();
          if (leg.speechStoppedAt) {
            const toText = transcriptAt ? `text ${transcriptAt - leg.speechStoppedAt} ms, ` : '';
            console.log(`[LAT ${role}] ${toText}AI voice ${firstAudioAt - leg.speechStoppedAt} ms after end of speech`);
          }
        }
        enqueueMulaw(other, mulaw);
      },
      onSpeechStopped: () => { leg.speechStoppedAt = Date.now(); firstAudioAt = 0; transcriptAt = 0; },
      // Nothing is spoken until the text has been seen. The model answers only when we ask it
      // to, so echo and junk are dropped before any audio exists — which is why the mic no
      // longer has to be muted during playback, and speech is no longer cut into fragments.
      onInputTranscript: (text, lang) => {
        transcriptAt = Date.now();
        if (!text) return;
        if (isEcho(leg, text)) return console.log(`[${role}] skipped (our own voice echoed back): "${text}"`);
        if (!isSpeakable(text)) return console.log(`[${role}] skipped (not speech): "${text}"`);
        console.log(`[${role}] heard "${text}"`);
        addTranscript(pairId, role, 'original', text);
        rt.respond();
        if (role !== 'caller') return;
        const s = sessionStore.get(pairId);
        if (lang) return noteCallerLang(s, lang);
        if (s?.callerLang) return;
        // no language on the event: ask separately, off the critical path
        detectLanguage(text).then((l) => noteCallerLang(sessionStore.get(pairId), l)).catch(() => {});
      },
      onOutputTranscript: (text) => {
        if (!text) return;
        noteSpoken(pairs.get(pairId) || {}, text);
        console.log(`[${role}] -> "${text}"`);
        addTranscript(pairId, role, 'translated', text);
      },
    });
    leg.rt = rt;
  }

  // Simultaneous path: audio streams through, translated audio streams back. Transcripts arrive
  // in pieces, so they are joined per burst for the log and for detecting the caller's language.
  function startGemini(leg, session) {
    let heard = '';
    let said = '';
    let flushTimer = null;
    const flush = () => {
      const text = heard.trim();
      if (said.trim()) {
        noteSpoken(pairs.get(pairId) || {}, said);
        console.log(`[${role}] -> "${said.trim()}"`);
        addTranscript(pairId, role, 'translated', said.trim());
      }
      heard = '';
      said = '';
      if (!text) return;
      console.log(`[${role}] heard "${text}"`);
      addTranscript(pairId, role, 'original', text);
      if (role !== 'caller' || !isSpeakable(text)) return;
      detectLanguage(text).then((l) => noteCallerLang(sessionStore.get(pairId), l)).catch(() => {});
    };
    const later = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200); };
    gem = createGemini({
      label: role,
      targetLang: targetLangFor(session),
      onAudio: (mulaw) => {
        const other = pairs.get(pairId)?.[otherRole];
        if (!other) return;
        if (leg.speechStartedAt) {
          const ms = Date.now() - leg.speechStartedAt;
          if (ms < 10000) console.log(`[LAT ${role}] AI voice ${ms} ms after start of speech`);
          leg.speechStartedAt = 0;
        }
        enqueueMulaw(other, mulaw);
      },
      onInputTranscript: (t) => { heard += t; later(); },
      onOutputTranscript: (t) => { said += t; later(); },
    });
    leg.rt = gem; // so the other leg can retarget it once the caller's language is known
  }

  function handleUtterance(text, sttLang) {
    const pair = pairs.get(pairId);
    if (!pair) return;
    const me = pair[role];
    const heardAt = Date.now();
    const sttMs = me.speechStoppedAt ? heardAt - me.speechStoppedAt : null;

    // laughter, filler and noise must never be spoken — the TTS would read them out literally
    if (!isSpeakable(text)) {
      console.log(`[${role}] skipped (not speech): "${text}"`);
      return;
    }
    // our own AI voice coming back on this leg's mic — translating it again would loop
    if (isEcho(me, text)) {
      console.log(`[${role}] skipped (our own voice echoed back): "${text}"`);
      return;
    }

    // one utterance at a time per speaker, so the order is kept
    me.chain = me.chain.then(async () => {
      const session = sessionStore.get(pairId);
      const target = targetLangFor(session);
      const myLang = role === 'caller' ? (sttLang || session?.callerLang) : (session?.targetLang || sttLang);
      try {
        let lang = myLang || '';
        let out = text;
        let itpMs = 0;
        // same language on both sides: no translation needed, so skip the LLM entirely —
        // saves a round trip and removes any chance of it inventing a sentence
        if (!myLang || myLang !== target) {
          const t0 = Date.now();
          const r = await interpret(text, target);
          itpMs = Date.now() - t0;
          lang = r.lang || myLang || '';
          out = r.text;
        }
        noteCallerLang(session, lang);
        console.log(`[${role}] (${lang}) "${text}" -> (${target}) "${out}"`);
        addTranscript(pairId, role, 'original', text);
        addTranscript(pairId, role, 'translated', out);
        if (!isSpeakable(out)) return;
        const other = pairs.get(pairId)?.[otherRole];
        if (!other) return;
        noteSpoken(pairs.get(pairId) || {}, out); // so its echo is recognised on either phone
        const t1 = Date.now();
        let first = true;
        await speak(out, (pcm) => {
          enqueuePcm(other, pcm);
          if (first) {
            first = false;
            const parts = [sttMs === null ? null : `stt ${sttMs}`, itpMs ? `itp ${itpMs}` : 'itp skipped', `tts ${Date.now() - t1}`];
            console.log(`[LAT ${role}] ${parts.filter(Boolean).join(' + ')} = ${Date.now() - (me.speechStoppedAt || heardAt)} ms`);
          }
        });
      } catch (err) {
        console.error(`[PIPE ${role}] ${err.message}`);
      }
    });
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.event) {
      case 'start': {
        const params = msg.start.customParameters || {};
        pairId = params.pairId;
        role = params.role; // 'caller' | 'callee'
        otherRole = role === 'caller' ? 'callee' : 'caller';
        if (!pairs.has(pairId)) pairs.set(pairId, { caller: newLeg(), callee: newLeg() });
        const leg = pairs.get(pairId)[role];
        Object.assign(leg, { ws, streamSid: msg.start.streamSid, callSid: msg.start.callSid });
        const session = sessionStore.get(pairId);
        // the callee's language comes from the menu; the caller's is detected, so start on auto
        const known = role === 'callee' ? session?.targetLang : session?.callerLang;
        if (USE_GEMINI) {
          startGemini(leg, session);
        } else if (USE_REALTIME) {
          startRealtime(leg, session);
        } else {
          stt = createTranscriber({
            label: role,
            language: known && KNOWN_LANGS.has(known) ? known : null,
            onUtterance: handleUtterance,
            onSpeechStopped: () => { leg.speechStoppedAt = Date.now(); },
          });
        }
        console.log(`[STREAM] ${role} started — pair ${pairId}`);
        break;
      }

      case 'media': {
        if (!msg.media?.payload) break;
        const me = pairs.get(pairId)?.[role];
        if (!me) break;
        const mulaw = Buffer.from(msg.media.payload, 'base64');

        if (gem) {
          // The model translates as audio arrives, so there is no transcript to check before it
          // speaks: our own voice coming back on this mic has to be kept out while it plays.
          const playing = Date.now() <= me.echoHoldUntil;
          gem.sendAudio(playing ? (mulaw.length === 160 ? SILENT_FRAME : Buffer.alloc(mulaw.length, 0xff).toString('base64')) : msg.media.payload);
          if (!playing && !me.speechStartedAt && rms(decodeMulaw(mulaw)) >= GATE_RMS) me.speechStartedAt = Date.now();
          pump(me, mulaw.length);
          break;
        }
        if (rt) {
          // passed through untouched: the model's VAD and noise reduction do the work, and the
          // echo of our own voice is caught on the transcript instead of by muting the mic
          rt.sendAudio(msg.media.payload);
          pump(me, mulaw.length);
          break;
        }
        if (!stt) break;
        const samples = new Int16Array(mulaw.length);
        for (let i = 0; i < mulaw.length; i++) samples[i] = MULAW_DECODE[mulaw[i]];

        // echo suppression: our own AI voice comes back on this leg's mic, so mute STT while it plays
        const now = Date.now();
        const echoing = now <= me.echoHoldUntil;
        // noise gate: line noise goes to STT as silence (prevents invented sentences)
        if (!echoing && rms(samples) >= GATE_RMS) me.gateOpenUntil = now + GATE_HOLD_MS;
        const open = !echoing && now <= me.gateOpenUntil;
        stt.sendAudio(open ? msg.media.payload : (mulaw.length === 160 ? SILENT_FRAME : Buffer.alloc(mulaw.length, 0xff).toString('base64')));

        pump(me, mulaw.length); // this leg's clock drives playback of the AI voice meant for it
        break;
      }

      case 'stop':
        console.log(`[STREAM] ${role} stopped — pair ${pairId}`);
        cleanup();
        break;
    }
  });

  ws.on('close', cleanup);
  ws.on('error', (err) => console.error('[STREAM] ws error:', err.message));

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stt?.close();
    rt?.close();
    gem?.close();
    const pair = pairs.get(pairId);
    if (!pair) return;
    const other = pair[otherRole];
    if (other?.callSid) hangupCall(other.callSid); // one side hung up -> end the other side
    const session = sessionStore.get(pairId);
    if (session) session.status = 'completed';
    pairs.delete(pairId);
  }
}
