import { createTranslator, MULAW_DECODE, mulawEncode } from '../services/realtimeTranslator.js';
import { sessionStore } from '../services/sessionStore.js';
import { hangupCall } from '../services/twilioClient.js';

/**
 * Each call (caller leg A, callee leg B) has its own bidirectional Twilio stream.
 * pairs[pairId] = { caller: leg, callee: leg }
 *
 * Every 20 ms frame that arrives from one leg drives one outgoing frame to the other leg:
 *   out = original voice (quiet, "ducked" while a translation plays) + translated speech
 * So each side hears the other person immediately and the translation on top
 * (OpenAI recommends original-audio passthrough with ducking for phone bridges).
 */
const pairs = new Map();

const PASS_GAIN = num(process.env.PASSTHROUGH_GAIN, 0.35);   // original voice when no translation plays
const DUCK_GAIN = num(process.env.DUCK_GAIN, 0.08);          // original voice while translation plays
const GATE_RMS = num(process.env.NOISE_GATE_RMS, 250);       // below = treated as silence for the model
const GATE_HOLD_MS = 500;                                     // keep gate open after speech
const MAX_BACKLOG_MS = num(process.env.MAX_BACKLOG_MS, 1500); // translation backlog before pauses get skipped
const SILENT_RMS = 150;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; }

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

function newLeg() {
  return { ws: null, streamSid: null, callSid: null, tq: [], tqLen: 0, playing: false,
    gateOpenUntil: 0, speechStartedAt: 0, waitingFirstAudio: false };
}

// translated audio for a leg: queue of Int16Array chunks
function enqueueTranslation(leg, pcm) {
  leg.tq.push(pcm);
  leg.tqLen += pcm.length;
  // backlog control: drop near-silent chunks if we fall behind
  if (leg.tqLen > MAX_BACKLOG_MS * 8) {
    const kept = [];
    let len = 0;
    for (const c of leg.tq) {
      if (len > 0 && rms(c) < SILENT_RMS && leg.tqLen - c.length > 400 * 8) { leg.tqLen -= c.length; continue; }
      kept.push(c); len += c.length;
    }
    leg.tq = kept;
  }
}

function takeTranslation(leg, n) {
  const out = new Int16Array(n);
  let filled = 0;
  while (filled < n && leg.tq.length) {
    const c = leg.tq[0];
    const k = Math.min(n - filled, c.length);
    out.set(c.subarray(0, k), filled);
    filled += k;
    if (k === c.length) leg.tq.shift(); else leg.tq[0] = c.subarray(k);
    leg.tqLen -= k;
  }
  return { samples: out, active: filled > 0 };
}

function addTranscript(pairId, speaker, kind, text) {
  const session = sessionStore.get(pairId);
  if (session) session.transcript.push({ timestamp: new Date().toISOString(), speaker, kind, text });
}

export function handleMediaStream(ws) {
  let pairId = null;
  let role = null;
  let otherRole = null;
  let translator = null;
  let statsAt = Date.now();

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.event) {
      case 'start': {
        const params = msg.start.customParameters || {};
        pairId = params.pairId;
        role = params.role; // 'caller' | 'callee'
        otherRole = role === 'caller' ? 'callee' : 'caller';
        const session = sessionStore.get(pairId);
        const callerLang = session?.callerLang || process.env.CALLER_LANG || 'en';
        const targetLang = session?.targetLang || process.env.TARGET_LANG || 'de';
        const to = role === 'caller' ? targetLang : callerLang;

        if (!pairs.has(pairId)) pairs.set(pairId, { caller: newLeg(), callee: newLeg() });
        const me = pairs.get(pairId)[role];
        Object.assign(me, { ws, streamSid: msg.start.streamSid, callSid: msg.start.callSid });

        translator = createTranslator({
          to, label: role,
          onAudio: (pcm) => {
            const other = pairs.get(pairId)?.[otherRole];
            if (!other) return;
            // latency: my speech start -> first translated audio for the other side
            if (me.waitingFirstAudio && rms(pcm) > SILENT_RMS) {
              me.waitingFirstAudio = false;
              console.log(`[LAT ${role}] ${Date.now() - me.speechStartedAt} ms speech -> translated audio`);
            }
            enqueueTranslation(other, pcm);
          },
          onTranscript: (kind, text) => addTranscript(pairId, role, kind, text),
        });
        console.log(`[STREAM] ${role} started — pair ${pairId}, call ${me.callSid}, -> ${to}`);
        break;
      }

      case 'media': {
        if (!translator || !msg.media?.payload) break;
        const pair = pairs.get(pairId);
        if (!pair) break;
        const me = pair[role];
        const other = pair[otherRole];
        const mulaw = Buffer.from(msg.media.payload, 'base64');
        const orig = new Int16Array(mulaw.length);
        for (let i = 0; i < mulaw.length; i++) orig[i] = MULAW_DECODE[mulaw[i]];

        // 1) my voice -> my translator (noise gate: line noise is sent as silence)
        const now = Date.now();
        const level = rms(orig);
        if (level >= GATE_RMS) {
          if (now > me.gateOpenUntil) { me.speechStartedAt = now; me.waitingFirstAudio = true; }
          me.gateOpenUntil = now + GATE_HOLD_MS;
        }
        if (now <= me.gateOpenUntil) translator.sendAudio(msg.media.payload);
        else translator.sendAudio(Buffer.alloc(mulaw.length, 0xff).toString('base64'));

        // 2) one outgoing frame for the other leg: my original (ducked) + its pending translation
        if (other?.ws?.readyState === 1 && other.streamSid) {
          const { samples: tr, active } = takeTranslation(other, orig.length);
          const gain = active ? DUCK_GAIN : PASS_GAIN;
          const out = Buffer.alloc(orig.length);
          for (let i = 0; i < orig.length; i++) out[i] = mulawEncode(Math.max(-32768, Math.min(32767, Math.round(orig[i] * gain + tr[i]))));
          other.ws.send(JSON.stringify({ event: 'media', streamSid: other.streamSid, media: { payload: out.toString('base64') } }));
        }

        if (now - statsAt > 10000) {
          statsAt = now;
          if (other?.tqLen) console.log(`[MIX ${otherRole}] translation backlog ${Math.round(other.tqLen / 8)} ms`);
        }
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
    translator?.close();
    const pair = pairs.get(pairId);
    if (!pair) return;
    const other = pair[otherRole];
    if (other?.callSid) hangupCall(other.callSid); // one side hung up -> end the other side
    const session = sessionStore.get(pairId);
    if (session) session.status = 'completed';
    pairs.delete(pairId);
  }
}
