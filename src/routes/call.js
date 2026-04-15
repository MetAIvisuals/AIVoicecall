import twilio from 'twilio';
import fetch from 'node-fetch';
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

  // Dial target into same conference
  getClient().calls.create({
    to: targetNumber,
    from: process.env.TWILIO_PHONE_NUMBER,
    twiml: `<Response>
      <Say voice="Polly.Marlene" language="de-DE">Bitte warten, Anruf wird verbunden.</Say>
      <Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${conferenceName}</Conference></Dial>
    </Response>`,
  }).then(call => {
    console.log(`[CALL] Outbound leg: ${call.sid}`);
    setTimeout(() => startConferenceStream(conferenceName, callSid, wsHost), 8000);
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

async function startConferenceStream(conferenceName, callSid, wsHost) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  try {
    // Look up the conference SID
    const conferences = await getClient().conferences.list({
      friendlyName: conferenceName,
      status: 'in-progress',
      limit: 1,
    });

    if (!conferences.length) {
      console.log(`[CALL] Conference not active yet, retrying in 3s...`);
      setTimeout(() => startConferenceStream(conferenceName, callSid, wsHost), 3000);
      return;
    }

    const conferenceSid = conferences[0].sid;
    console.log(`[CALL] Attaching stream to conference ${conferenceSid}`);

    // Use raw REST API — SDK doesn't support conference streams yet
    const url = `https://insights.twilio.com/v1/Voice/Streams`;
    const body = new URLSearchParams({
      ConferenceSid: conferenceSid,
      StreamUrl: `wss://${wsHost}/media-stream`,
      Track: 'inbound_track',
      'Parameter1.Name': 'callSid',
      'Parameter1.Value': callSid,
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const result = await resp.json();
    if (resp.ok) {
      console.log(`[CALL] Stream attached: ${result.sid}`);
    } else {
      console.error(`[CALL] Stream attach failed: ${JSON.stringify(result)}`);
      // Fallback: inject stream on inbound call leg directly
      await injectStreamOnCallLeg(callSid, wsHost);
    }
  } catch (err) {
    console.error(`[CALL] startConferenceStream error: ${err.message}`);
    await injectStreamOnCallLeg(callSid, wsHost);
  }
}

// Fallback: inject stream directly onto the inbound call leg
async function injectStreamOnCallLeg(callSid, wsHost) {
  console.log(`[CALL] Fallback: injecting stream on call leg ${callSid}`);
  try {
    // We use <Start><Stream> which runs alongside the existing call without replacing it
    await getClient().calls(callSid).update({
      twiml: `<Response>
        <Start>
          <Stream url="wss://${wsHost}/media-stream" track="inbound_track">
            <Parameter name="callSid" value="${callSid}"/>
          </Stream>
        </Start>
        <Pause length="3600"/>
      </Response>`,
    });
    console.log(`[CALL] Stream injected on call leg ${callSid}`);
  } catch (err) {
    console.error(`[CALL] Fallback stream inject failed: ${err.message}`);
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
