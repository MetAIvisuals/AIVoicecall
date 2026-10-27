import twilio from 'twilio';

let _client = null;
function getClient() {
  if (!_client) _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _client;
}

export async function hangupCall(callSid) {
  try {
    await getClient().calls(callSid).update({ status: 'completed' });
    console.log(`[TWILIO] Hung up ${callSid}`);
  } catch (err) {
    if (err.status !== 404) console.error(`[TWILIO] Hangup failed for ${callSid}: ${err.message}`);
  }
}

export { getClient as client };
