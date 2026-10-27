import { createTranscriber } from '../services/transcriber.js';
import { interpret, isSpeakable, KNOWN_LANGS } from '../services/interpreter.js';
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
const ECHO_TAIL_MS = Number(process.env.ECHO_TAIL_MS || 200);
const SILENT_RMS = 150;
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString('base64');

function newLeg() {
  return { ws: null, streamSid: null, callSid: null, out: [], outLen: 0, gateOpenUntil: 0, echoHoldUntil: 0, speechStoppedAt: 0, chain: Promise.resolve() };
}

function enqueue(leg, pcm) {
  leg.out.push(pcm);
  leg.outLen += pcm.length;
  if (leg.outLen > MAX_BACKLOG_MS * 8) { // falling behind: drop near-silent chunks
    leg.out = leg.out.filter((c, i) => {
      if (i > 0 && rms(c) < SILENT_RMS) { leg.outLen -= c.length; return false; }
      return true;
    });
  }
}

// called on every 20 ms frame received from a leg: send that leg one frame of its pending AI audio
function pump(leg, n) {
  if (!leg.outLen || leg.ws?.readyState !== 1 || !leg.streamSid) return;
  const frame = Buffer.alloc(n, 0xff);
  let filled = 0;
  while (filled < n && leg.out.length) {
    const c = leg.out[0];
    const k = Math.min(n - filled, c.length);
    for (let i = 0; i < k; i++) frame[filled + i] = mulawEncode(c[i]);
    filled += k;
    if (k === c.length) leg.out.shift(); else leg.out[0] = c.subarray(k);
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
    } else {
      session.langCandidate = lang; // needs a second utterance to confirm
    }
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
        const t1 = Date.now();
        let first = true;
        await speak(out, (pcm) => {
          if (first) {
            first = false;
            const parts = [sttMs === null ? null : `stt ${sttMs}`, itpMs ? `itp ${itpMs}` : 'itp skipped', `tts ${Date.now() - t1}`];
            console.log(`[LAT ${role}] ${parts.filter(Boolean).join(' + ')} = ${Date.now() - (me.speechStoppedAt || heardAt)} ms`);
          }
          enqueue(other, pcm);
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
        stt = createTranscriber({
          label: role,
          language: known && KNOWN_LANGS.has(known) ? known : null,
          onUtterance: handleUtterance,
          onSpeechStopped: () => { leg.speechStoppedAt = Date.now(); },
        });
        console.log(`[STREAM] ${role} started — pair ${pairId}`);
        break;
      }

      case 'media': {
        if (!stt || !msg.media?.payload) break;
        const me = pairs.get(pairId)?.[role];
        if (!me) break;
        const mulaw = Buffer.from(msg.media.payload, 'base64');
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
    const pair = pairs.get(pairId);
    if (!pair) return;
    const other = pair[otherRole];
    if (other?.callSid) hangupCall(other.callSid); // one side hung up -> end the other side
    const session = sessionStore.get(pairId);
    if (session) session.status = 'completed';
    pairs.delete(pairId);
  }
}
