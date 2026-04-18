import twilio from 'twilio';

let _client = null;
function getClient() {
  if (!_client) _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

export async function injectAudioIntoCall(callSid, audioUrl) {
  const twiml = `<Response><Play>${audioUrl}</Play></Response>`;
  try {
    await getClient().calls(callSid).update({ twiml });
    console.log(`[TWILIO] Injected audio into call ${callSid}`);
  } catch (err) {
    console.error(`[TWILIO] Failed to inject audio: ${err.message}`);
  }
}

export { getClient as client };
