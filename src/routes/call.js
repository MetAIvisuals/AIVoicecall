import twilio from 'twilio';
import { sessionStore } from '../services/sessionStore.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

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

  console.log(`[CALL] SERVER_URL=${serverUrl}, wsHost=${wsHost}`);

  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.'
  );

  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${wsHost}/media-stream`,
    track: 'inbound_track',
  });
  stream.parameter({ name: 'callSid', value: callSid });

  const dial = twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    action: `${serverUrl}/call/status`,
    method: 'POST',
    timeout: 30,
  });
  dial.number(targetNumber);

  res.type('text/xml').send(twiml.toString());
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
