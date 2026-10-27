import { createTranscriber } from '../services/transcriber.js';
import { interpret } from '../services/interpreter.js';
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
const SILENT_RMS = 150;
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString('base64');

function newLeg() {
  return { ws: null, streamSid: null, callSid: null, out: [], outLen: 0, gateOpenUntil: 0, chain: Promise.resolve(), context: [] };
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

  function handleUtterance(text) {
    const pair = pairs.get(pairId);
    if (!pair) return;
    const me = pair[role];
    const heardAt = Date.now();
    // one utterance at a time per speaker, so the order is kept
    me.chain = me.chain.then(async () => {
      const session = sessionStore.get(pairId);
      const target = targetLangFor(session);
      try {
        const { lang, text: out } = await interpret(text, target, me.context.slice(-4));
        if (role === 'caller' && lang && session && session.callerLang !== lang) {
          session.callerLang = lang;
          console.log(`[LANG] caller speaks ${lang}`);
        }
        console.log(`[${role}] (${lang}) "${text}" -> (${target}) "${out}"`);
        addTranscript(pairId, role, 'original', text);
        addTranscript(pairId, role, 'translated', out);
        me.context.push(text);
        if (!out) return;
        const other = pairs.get(pairId)?.[otherRole];
        if (!other) return;
        let first = true;
        await speak(out, (pcm) => {
          if (first) { first = false; console.log(`[LAT ${role}] ${Date.now() - heardAt} ms end of speech -> AI voice`); }
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
        Object.assign(pairs.get(pairId)[role], { ws, streamSid: msg.start.streamSid, callSid: msg.start.callSid });
        stt = createTranscriber({ label: role, onUtterance: handleUtterance });
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

        // noise gate: line noise goes to STT as silence (prevents invented sentences)
        const now = Date.now();
        if (rms(samples) >= GATE_RMS) me.gateOpenUntil = now + GATE_HOLD_MS;
        stt.sendAudio(now <= me.gateOpenUntil ? msg.media.payload : (mulaw.length === 160 ? SILENT_FRAME : Buffer.alloc(mulaw.length, 0xff).toString('base64')));

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
