import twilio from 'twilio';
import { sessionStore } from '../services/sessionStore.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

export function handleInboundCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const targetNumber = process.env.DEFAULT_TARGET_NUMBER;

  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  sessionStore.set(callSid, {
    callSid,
    from,
    targetNumber,
    status: 'active',
    startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  const wsHost = serverUrl.replace(/^https?:\/\//, '');

  console.log(`[CALL] Dialling ${targetNumber}, stream at wss://${wsHost}/media-stream`);

  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.'
  );

  // Dial target — when they answer, open the media stream on the inbound leg
  const dial = twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    action: `${serverUrl}/call/status`,
    method: 'POST',
    timeout: 30,
    record: 'do-not-record',
  });
  dial.number({
    statusCallback: `${serverUrl}/call/answered?callSid=${callSid}&wsHost=${wsHost}`,
    statusCallbackEvent: 'answered',
    statusCallbackMethod: 'POST',
  }, targetNumber);

  res.type('text/xml').send(twiml.toString());
}

// Called when the target answers — we open the media stream on the parent call
export async function handleCallAnswered(req, res) {
  res.sendStatus(200);

  const { callSid, wsHost } = req.query;
  const parentCallSid = callSid;

  console.log(`[CALL] Target answered, opening stream on ${parentCallSid}`);

  try {
    const streamTwiml = `<Response>
      <Connect>
        <Stream url="wss://${wsHost}/media-stream" track="inbound_track">
          <Parameter name="callSid" value="${parentCallSid}"/>
        </Stream>
      </Connect>
    </Response>`;

    await getClient().calls(parentCallSid).update({ twiml: streamTwiml });
    console.log(`[CALL] Stream injected into call ${parentCallSid}`);
  } catch (err) {
    console.error(`[CALL] Failed to inject stream: ${err.message}`);
  }
}

export function handleCallStatus(req, res) {
  const { CallSid, DialCallStatus } = req.body;
  console.log(`[CALL] Status update for ${CallSid}: ${DialCallStatus}`);

  const session = sessionStore.get(CallSid);
  if (session) {
    session.status = DialCallStatus;
    sessionStore.set(CallSid, session);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
}
