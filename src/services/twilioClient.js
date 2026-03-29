import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Uses Twilio's <Play> verb via the Calls REST API to inject
 * a translated audio clip into a live call.
 *
 * This uses Twilio's "Modify Live Call" feature — we POST new TwiML
 * to the call while it's in progress.
 */
export async function injectAudioIntoCall(callSid, audioUrl) {
  const twiml = `
    <Response>
      <Play>${audioUrl}</Play>
    </Response>
  `.trim();

  try {
    await client.calls(callSid).update({
      twiml,
    });
    console.log(`[TWILIO] Injected audio into call ${callSid}`);
  } catch (err) {
    console.error(`[TWILIO] Failed to inject audio: ${err.message}`);
    throw err;
  }
}

export { client };
