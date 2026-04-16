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

  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  sessionStore.set(callSid, {
    callSid, from, targetNumber, wsHost, serverUrl,
    status: 'active', startedAt: new Date().toISOString(),
    callerLang: process.env.CALLER_LANG || 'en',
    targetLang: process.env.TARGET_LANG || 'de',
    transcript: [],
  });

  // Simple approach: Start stream + Dial number directly
  // <Start> is non-blocking, stream runs for lifetime of call
  // <Dial> bridges to target number
  const twiml = new VoiceResponse();

  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.');

  const start = twiml.start();
  const stream = start.stream({
    url: `wss://${wsHost}/media-stream`,
    track: 'both_tracks',
  });
  stream.parameter({ name: 'callSid', value: callSid });

  const dial = twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    action: `${serverUrl}/call/status`,
    method: 'POST',
    timeout: 30,
  });
  dial.number(targetNumber);

  const twimlStr = twiml.toString();
  console.log(`[CALL] TwiML: ${twimlStr}`);
  res.type('text/xml').send(twimlStr);
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
