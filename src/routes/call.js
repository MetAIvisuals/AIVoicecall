import twilio from 'twilio';
import { sessionStore } from '../services/sessionStore.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

/**
 * Called when someone dials your Twilio number.
 * We greet them, then connect a Media Stream for real-time audio,
 * and simultaneously dial the target number.
 */
export function handleInboundCall(req, res) {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const targetNumber = req.body.To === process.env.TWILIO_PHONE_NUMBER
    ? process.env.DEFAULT_TARGET_NUMBER   // demo: always bridge to this number
    : req.body.To;

  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  // Create a session to track this call
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

  const host = process.env.SERVER_URL; // e.g. https://yourapp.ngrok.io
  const twiml = new VoiceResponse();

  // Brief greeting
  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    'Connecting your call with live translation. Please wait.'
  );

  // Open a Media Stream so we can capture audio in real time
  const connect = twiml.connect();
  const stream = connect.stream({
    url: `wss://${host.replace(/^https?:\/\//, '')}/media-stream`,
    track: 'inbound_track',   // capture caller's audio
  });
  stream.parameter({ name: 'callSid', value: callSid });

  // Dial the German party — Twilio bridges the two legs
  const dial = twiml.dial({
    callerId: process.env.TWILIO_PHONE_NUMBER,
    action: `${host}/call/status`,
    method: 'POST',
    timeout: 30,
  });
  dial.number(targetNumber);

  res.type('text/xml').send(twiml.toString());
}

/**
 * Called when the dialed leg completes.
 */
export function handleCallStatus(req, res) {
  const { CallSid, DialCallStatus } = req.body;
  console.log(`[CALL] Status update for ${CallSid}: ${DialCallStatus}`);

  const session = sessionStore.get(CallSid);
  if (session) {
    session.status = DialCallStatus;
    sessionStore.set(CallSid, session);
  }

  // Hang up cleanly
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
}
