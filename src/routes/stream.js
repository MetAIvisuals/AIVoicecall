import { createTranslator } from '../services/realtimeTranslator.js';
import { sessionStore } from '../services/sessionStore.js';
import { hangupCall } from '../services/twilioClient.js';

/**
 * Each call (caller leg A, callee leg B) opens its own bidirectional Twilio stream.
 * pairs[pairId] = { caller: leg, callee: leg }, leg = { ws, streamSid, callSid, queue }
 * A's speech -> translator A->B -> played to B; B's speech -> translator B->A -> played to A.
 */
const pairs = new Map();

function sendToLeg(leg, payload) {
  if (leg?.ws?.readyState === 1 && leg.streamSid) {
    leg.ws.send(JSON.stringify({ event: 'media', streamSid: leg.streamSid, media: { payload } }));
  } else if (leg) {
    leg.queue.push(payload);
  }
}

function addTranscript(pairId, speaker, kind, text) {
  const session = sessionStore.get(pairId);
  if (!session) return;
  session.transcript.push({ timestamp: new Date().toISOString(), speaker, kind, text });
}

export function handleMediaStream(ws) {
  let pairId = null;
  let role = null;
  let translator = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.event) {
      case 'start': {
        const params = msg.start.customParameters || {};
        pairId = params.pairId;
        role = params.role; // 'caller' | 'callee'
        const session = sessionStore.get(pairId);
        const callerLang = session?.callerLang || process.env.CALLER_LANG || 'en';
        const targetLang = session?.targetLang || process.env.TARGET_LANG || 'de';

        if (!pairs.has(pairId)) pairs.set(pairId, {});
        const pair = pairs.get(pairId);
        const leg = { ws, streamSid: msg.start.streamSid, callSid: msg.start.callSid, queue: [] };
        // keep audio that arrived for this leg before it connected
        const earlier = pair[role];
        if (earlier?.queue?.length) leg.queue = earlier.queue;
        pair[role] = leg;
        for (const p of leg.queue.splice(0)) sendToLeg(leg, p);

        const otherRole = role === 'caller' ? 'callee' : 'caller';
        const [from, to] = role === 'caller' ? [callerLang, targetLang] : [targetLang, callerLang];

        translator = createTranslator({
          from, to, label: role,
          onAudio: (payload) => {
            const p = pairs.get(pairId);
            if (!p) return;
            if (!p[otherRole]) p[otherRole] = { queue: [] };
            sendToLeg(p[otherRole], payload);
          },
          onTranscript: (kind, text) => addTranscript(pairId, role, kind, text),
        });
        console.log(`[STREAM] ${role} started — pair ${pairId}, call ${leg.callSid}`);
        break;
      }

      case 'media':
        if (translator && msg.media?.payload) translator.sendAudio(msg.media.payload);
        break;

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
    // one side hung up -> end the other side too
    const otherRole = role === 'caller' ? 'callee' : 'caller';
    const other = pair[otherRole];
    if (other?.callSid) hangupCall(other.callSid);
    const session = sessionStore.get(pairId);
    if (session) session.status = 'completed';
    pairs.delete(pairId);
  }
}
