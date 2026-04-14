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
    status: 'active',
    startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  // Dial the target number — when they answer they join the conference
  getClient().calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    twiml: `<Response>
      <Say voice="Polly.Marlene" language="de-DE">Bitte warten Sie, ein Anruf wird verbunden.</Say>
      <Dial>
        <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">
          ${conferenceName}
        </Conference>
      </Dial>
    </Response>`,
  }).then(call => {
    console.log(`[CALL] Outbound leg created: ${call.sid}`);
  }).catch(err => {
    console.error(`[CALL] Failed to dial target: ${err.message}`);
  });

  // Put caller into the same conference with media stream
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.');

  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${wsHost}/media-stream`,
    track: 'inbound_track',
  });
  stream.parameter({ name: 'callSid', value: callSid });

  const dial = twiml.dial();
  dial.conference({
    beep: false,
    startConferenceOnEnter: false,
    endConferenceOnExit: true,
    waitUrl: '',
  }, conferenceName);

  res.type('text/xml').send(twiml.toString());
}

export function handleCallAnswered(req, res) {
  res.sendStatus(200);
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
