import { transcribeAudio } from '../services/whisper.js';
import { translateText } from '../services/translate.js';
import { synthesizeSpeech } from '../services/elevenlabs.js';
import { sessionStore } from '../services/sessionStore.js';
import { injectAudioIntoCall } from '../services/twilioClient.js';

/**
 * Handles the Twilio Media Stream WebSocket.
 *
 * Twilio sends audio as base64-encoded mulaw chunks (20ms each).
 * We buffer them, run silence detection, then when the caller
 * pauses we: transcribe → translate → TTS → inject back into the call.
 */
export function handleMediaStream(ws, req) {
  let callSid = null;
  let audioBuffer = Buffer.alloc(0);
  let silenceTimer = null;
  let streamSid = null;
  let isSpeaking = false;

  const SILENCE_THRESHOLD_MS = 1200; // wait this long after last audio chunk
  const MIN_AUDIO_MS = 400;           // ignore clips shorter than this
  const SAMPLE_RATE = 8000;           // Twilio mulaw = 8kHz
  const BYTES_PER_MS = SAMPLE_RATE / 1000; // 8 bytes/ms

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log('[STREAM] Connected');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        callSid = msg.start.customParameters?.callSid || null;
        console.log(`[STREAM] Started — CallSid: ${callSid}, StreamSid: ${streamSid}`);
        break;

      case 'media': {
        const chunk = Buffer.from(msg.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
        isSpeaking = true;

        // Reset silence timer on every incoming chunk
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          isSpeaking = false;
          const capturedBuffer = audioBuffer;
          audioBuffer = Buffer.alloc(0);

          const durationMs = capturedBuffer.length / BYTES_PER_MS;
          if (durationMs < MIN_AUDIO_MS) return; // too short, skip

          console.log(`[STREAM] Processing ${Math.round(durationMs)}ms of audio`);
          await processUtterance(capturedBuffer, callSid, streamSid);
        }, SILENCE_THRESHOLD_MS);

        break;
      }

      case 'stop':
        console.log('[STREAM] Stopped');
        clearTimeout(silenceTimer);
        break;
    }
  });

  ws.on('close', () => {
    console.log('[STREAM] WebSocket closed');
    clearTimeout(silenceTimer);
  });
}

/**
 * Core pipeline: raw mulaw buffer → translated speech injected into call
 */
async function processUtterance(mulawBuffer, callSid, streamSid) {
  const session = callSid ? sessionStore.get(callSid) : null;
  const callerLang = session?.callerLang || 'en';
  const targetLang = session?.targetLang || 'de';

  try {
    // 1. Transcribe with Whisper
    console.log('[PIPELINE] Transcribing...');
    const originalText = await transcribeAudio(mulawBuffer, callerLang);
    if (!originalText || originalText.trim().length < 2) {
      console.log('[PIPELINE] Empty transcription, skipping');
      return;
    }
    console.log(`[PIPELINE] Transcribed: "${originalText}"`);

    // 2. Translate
    console.log('[PIPELINE] Translating...');
    const translatedText = await translateText(originalText, callerLang, targetLang);
    console.log(`[PIPELINE] Translated: "${translatedText}"`);

    // 3. Text-to-Speech via ElevenLabs
    console.log('[PIPELINE] Synthesizing speech...');
    const audioUrl = await synthesizeSpeech(translatedText, targetLang);
    console.log(`[PIPELINE] Audio ready: ${audioUrl}`);

    // 4. Inject translated audio into the Twilio call
    if (callSid && audioUrl) {
      await injectAudioIntoCall(callSid, audioUrl);
    }

    // 5. Save to session transcript
    if (session) {
      session.transcript.push({
        timestamp: new Date().toISOString(),
        speaker: 'caller',
        original: originalText,
        translated: translatedText,
        lang: { from: callerLang, to: targetLang },
      });
      sessionStore.set(callSid, session);
    }

  } catch (err) {
    console.error('[PIPELINE] Error:', err.message);
  }
}
