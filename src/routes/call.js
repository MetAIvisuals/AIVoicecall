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
    callSid, from, targetNumber, conferenceName, wsHost, serverUrl,
    status: 'active', startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  // Dial target into the same conference
  getClient().calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    twiml: `<Response>
      <Say voice="Polly.Marlene" language="de-DE">Bitte warten, Anruf wird verbunden.</Say>
      <Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${conferenceName}</Conference></Dial>
    </Response>`,
  }).then(call => {
    console.log(`[CALL] Outbound leg: ${call.sid}`);
    // Start media stream on conference once outbound call is created
    setTimeout(() => startConferenceStream(conferenceName, callSid, wsHost, serverUrl), 8000);
  }).catch(err => console.error(`[CALL] Dial failed: ${err.message}`));

  // Put caller into conference
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, 'Connecting your call with live translation. Please wait.');
  const dial = twiml.dial({ action: `${serverUrl}/call/status`, method: 'POST' });
  dial.conference(conferenceName, {
    beep: false,
    startConferenceOnEnter: false,
    endConferenceOnExit: true,
    waitUrl: '',
  });

  res.type('text/xml').send(twiml.toString());
}

async function startConferenceStream(conferenceName, callSid, wsHost, serverUrl) {
  try {
    console.log(`[CALL] Looking up conference: ${conferenceName}`);
    const conferences = await getClient().conferences.list({ friendlyName: conferenceName, status: 'in-progress', limit: 1 });
    if (!conferences.length) {
      console.log(`[CALL] Conference not found or not active yet, retrying...`);
      setTimeout(() => startConferenceStream(conferenceName, callSid, wsHost, serverUrl), 3000);
      return;
    }
    const conferenceSid = conferences[0].sid;
    console.log(`[CALL] Starting stream on conference ${conferenceSid}`);
    await getClient().conferences(conferenceSid).streams.create({
      url: `wss://${wsHost}/media-stream`,
      track: 'inbound_track',
      parameter1: `callSid=${callSid}`,
    });
    console.log(`[CALL] Conference stream started`);
  } catch (err) {
    console.error(`[CALL] Conference stream failed: ${err.message}`);
  }
}

export function handleCallAnswered(req, res) { res.sendStatus(200); }

export function handleCallStatus(req, res) {
  const { CallSid, DialCallStatus } = req.body;
  console.log(`[CALL] Status update for ${CallSid}: ${DialCallStatus}`);
  const session = sessionStore.get(CallSid);
  if (session) { session.status = DialCallStatus; sessionStore.set(CallSid, session); }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
}
