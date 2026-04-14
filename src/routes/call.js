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
  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  const wsHost = serverUrl.replace(/^https?:\/\//, '');
  const conferenceName = `conf_${callSid}`;

  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  sessionStore.set(callSid, {
    callSid,
    from,
    targetNumber,
    conferenceName,
    wsHost,
    serverUrl,
    status: 'active',
    startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  // Dial target — joins same conference, fires callback when they answer
  getClient().calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    twiml: `<Response>
      <Say voice="Polly.Marlene" language="de-DE">Bitte warten, Anruf wird verbunden.</Say>
      <Dial>
        <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${conferenceName}</Conference>
      </Dial>
    </Response>`,
    statusCallback: `${serverUrl}/call/target-answered?callSid=${callSid}`,
    statusCallbackEvent: ['answered'],
    statusCallbackMethod: 'POST',
  }).then(call => {
    console.log(`[CALL] Outbound leg: ${call.sid}`);
  }).catch(err => {
    console.error(`[CALL] Dial failed: ${err.message}`);
  });

  // Put caller into conference — wait for target to join
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.');
  const dial = twiml.dial({ action: `${serverUrl}/call/status`, method: 'POST' });
  dial.conference(conferenceName, {
    beep: false,
    startConferenceOnEnter: false,
    endConferenceOnExit: true,
    waitUrl: '',
  });

  res.type('text/xml').send(twiml.toString());
}

// Fires when target answers — now open the media stream on the INBOUND call leg
export async function handleCallAnswered(req, res) {
  res.sendStatus(200);
  const { callSid } = req.query;
  const session = sessionStore.get(callSid);
  if (!session) return;

  const { wsHost } = session;
  console.log(`[CALL] Target answered — injecting stream on ${callSid}`);

  try {
    await getClient().calls(callSid).update({
      twiml: `<Response>
        <Connect>
          <Stream url="wss://${wsHost}/media-stream" track="inbound_track">
            <Parameter name="callSid" value="${callSid}"/>
          </Stream>
        </Connect>
      </Response>`,
    });
    console.log(`[CALL] Stream injected on ${callSid}`);
  } catch (err) {
    console.error(`[CALL] Stream inject failed: ${err.message}`);
  }
}

export function handleCallStatus(req, res) {
  const { CallSid, DialCallStatus } = req.body;
  console.log(`[CALL] Status update for ${CallSid}: ${DialCallStatus}`);
  const session = sessionStore.get(CallSid);
  if (session) { session.status = DialCallStatus; sessionStore.set(CallSid, session); }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
}
