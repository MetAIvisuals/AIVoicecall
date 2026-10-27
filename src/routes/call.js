import twilio from 'twilio';
import { sessionStore } from '../services/sessionStore.js';
import { client } from '../services/twilioClient.js';

const VoiceResponse = twilio.twiml.VoiceResponse;

// Keypad menu: digit -> language (all are output languages of gpt-realtime-translate)
const MENU = { 1: 'en', 2: 'de', 3: 'fr', 4: 'es', 5: 'it', 6: 'pt', 7: 'ru', 8: 'zh', 9: 'ja' };
const MENU_TEXT = '1 English. 2 German. 3 French. 4 Spanish. 5 Italian. 6 Portuguese. 7 Russian. 8 Chinese. 9 Japanese.';
const SAY = { voice: 'Polly.Joanna', language: 'en-US' };

function urls() {
  const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
  return { serverUrl, wsHost: serverUrl.replace(/^https?:\/\//, '') };
}

function streamTwiml(pairId, role) {
  const { wsHost } = urls();
  const twiml = new VoiceResponse();
  if (role === 'caller') {
    twiml.say(SAY, 'Connecting your call. Start speaking once the other person answers.');
  }
  const stream = twiml.connect().stream({ url: `wss://${wsHost}/media-stream` });
  stream.parameter({ name: 'pairId', value: pairId });
  stream.parameter({ name: 'role', value: role });
  return twiml.toString();
}

function askLanguage(res, step, prompt) {
  const { serverUrl } = urls();
  const twiml = new VoiceResponse();
  const g = twiml.gather({ numDigits: 1, timeout: 8, action: `${serverUrl}/call/menu/${step}`, method: 'POST' });
  g.say(SAY, `${prompt} ${MENU_TEXT}`);
  twiml.redirect({ method: 'POST' }, `${serverUrl}/call/menu/${step}`); // no input -> ask again
  res.type('text/xml').send(twiml.toString());
}

function askNumber(res) {
  const { serverUrl } = urls();
  const twiml = new VoiceResponse();
  const g = twiml.gather({
    finishOnKey: '#', timeout: 10, numDigits: 16,
    action: `${serverUrl}/call/menu/number`, method: 'POST',
  });
  g.say(SAY, 'Enter the phone number with country code, for example 4 3 for Austria, then press the hash key.'
    + (process.env.DEFAULT_TARGET_NUMBER ? ' To call the default number, just press hash.' : ''));
  twiml.redirect({ method: 'POST' }, `${serverUrl}/call/menu/askNumber`);
  res.type('text/xml').send(twiml.toString());
}

function isAllowedCaller(from) {
  const list = (process.env.ALLOWED_CALLERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(from);
}

// Step 0: caller dials the Twilio number
export function handleInboundCall(req, res) {
  const { CallSid: callSid, From: from } = req.body;
  console.log(`[CALL] Inbound from ${from}, CallSid: ${callSid}`);

  if (!isAllowedCaller(from)) {
    console.log(`[CALL] Rejected caller ${from} (not in ALLOWED_CALLERS)`);
    const twiml = new VoiceResponse();
    twiml.reject();
    return res.type('text/xml').send(twiml.toString());
  }

  sessionStore.set(callSid, {
    callSid, from, targetNumber: null,
    status: 'menu', startedAt: new Date().toISOString(),
    callerLang: null, targetLang: null, transcript: [],
  });
  askLanguage(res, 'source', 'Welcome to the call translator. Which language do you speak?');
}

// Step 1 + 2: choose own language, then target language
export function handleMenu(req, res) {
  const step = req.params.step;
  const { CallSid: callSid, Digits: digits } = req.body;
  const session = sessionStore.get(callSid);
  if (!session) return res.type('text/xml').send('<Response><Hangup/></Response>');
  const lang = MENU[digits];

  if (step === 'source') {
    if (!lang) return askLanguage(res, 'source', 'Which language do you speak?');
    session.callerLang = lang;
    return askLanguage(res, 'target', 'Which language does the person you are calling speak?');
  }

  if (step === 'target') {
    if (!lang) return askLanguage(res, 'target', 'Which language does the person you are calling speak?');
    session.targetLang = lang;
    return askNumber(res);
  }

  if (step === 'askNumber') return askNumber(res);

  if (step === 'number') {
    let number = (digits || '').replace(/\D/g, '');
    if (number.startsWith('00')) number = number.slice(2);
    number = number ? `+${number}` : (process.env.DEFAULT_TARGET_NUMBER || '');
    if (!/^\+\d{7,15}$/.test(number)) {
      const twiml = new VoiceResponse();
      twiml.say(SAY, 'That number is not valid. Please try again.');
      twiml.redirect({ method: 'POST' }, `${urls().serverUrl}/call/menu/askNumber`);
      return res.type('text/xml').send(twiml.toString());
    }
    session.targetNumber = number;
    session.status = 'active';
    console.log(`[CALL] ${callSid}: ${session.callerLang} -> ${session.targetLang}, dialing ${number}`);
    res.type('text/xml').send(streamTwiml(callSid, 'caller'));
    dialTarget(session);
    return;
  }

  res.sendStatus(404);
}

async function dialTarget(session) {
  const { serverUrl } = urls();
  try {
    const out = await client().calls.create({
      to: session.targetNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: streamTwiml(session.callSid, 'callee'),
      timeout: 30,
      statusCallback: `${serverUrl}/call/status`,
      statusCallbackEvent: ['completed'],
    });
    session.calleeSid = out.sid;
    console.log(`[CALL] Dialing target, CallSid: ${out.sid}`);
  } catch (err) {
    console.error(`[CALL] Could not dial target: ${err.message}`);
    try { await client().calls(session.callSid).update({ status: 'completed' }); } catch {}
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
