import twilio from 'twilio';
import { sessionStore } from '../services/sessionStore.js';
import { client } from '../services/twilioClient.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

function streamTwiml(wsHost, pairId, role) {
  const twiml = new VoiceResponse();
  if (role === 'caller') {
    twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
      'Connecting your call with live translation. Start speaking once the other person answers.');
  }
  const stream = twiml.connect().stream({ url: `wss://${wsHost}/media-stream` });
  stream.parameter({ name: 'pairId', value: pairId });
  stream.parameter({ name: 'role', value: role });
  return twiml.toString();
}

// Caller (A) dials the Twilio number. A gets its own stream; B is called separately.
// There is NO direct audio bridge: each side only hears the translation.
export async function handleInboundCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const targetNumber = process.env.DEFAULT_TARGET_NUMBER;
  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  const wsHost = serverUrl.replace(/^https?:\/\//, '');

  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  sessionStore.set(callSid, {
    callSid, from, targetNumber,
    status: 'active', startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  res.type('text/xml').send(streamTwiml(wsHost, callSid, 'caller'));

  try {
    const out = await client().calls.create({
      to: targetNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: streamTwiml(wsHost, callSid, 'callee'),
      timeout: 30,
      statusCallback: `${serverUrl}/call/status`,
      statusCallbackEvent: ['completed'],
    });
    const session = sessionStore.get(callSid);
    if (session) session.calleeSid = out.sid;
    console.log(`[CALL] Dialing target, CallSid: ${out.sid}`);
  } catch (err) {
    console.error(`[CALL] Could not dial target: ${err.message}`);
  }
}

export function handleCallAnswered(req, res) { res.sendStatus(200); }

// Fires when the callee leg ends (unanswered/busy/hung up): end the caller leg too.
export async function handleCallStatus(req, res) {
  const { CallSid, CallStatus } = req.body;
  console.log(`[CALL] Status ${CallSid}: ${CallStatus}`);
  for (const s of sessionStore.values()) {
    if (s.calleeSid === CallSid && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus)) {
      s.status = CallStatus;
      try { await client().calls(s.callSid).update({ status: 'completed' }); } catch {}
    }
  }
  res.sendStatus(200);
}
