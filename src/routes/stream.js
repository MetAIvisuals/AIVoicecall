import { transcribeAudio } from '../services/whisper.js';
import { translateText } from '../services/translate.js';
import { synthesizeSpeech } from '../services/elevenlabs.js';
import { sessionStore } from '../services/sessionStore.js';
import { injectAudioIntoCall } from '../services/twilioClient.js';

export function handleMediaStream(ws, req) {
  let callSid = null;
  let audioBuffer = Buffer.alloc(0);
  let silenceTimer = null;
  let streamSid = null;
  let keepAliveInterval = null;
  let mediaCount = 0;

  const SILENCE_THRESHOLD_MS = 1200;
  const MIN_AUDIO_MS = 400;
  const SAMPLE_RATE = 8000;
  const BYTES_PER_MS = SAMPLE_RATE / 1000;

  keepAliveInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 5000);

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
        console.log(`[STREAM] Started — CallSid: ${callSid}, tracks: ${JSON.stringify(msg.start.tracks)}`);
        break;

      case 'media': {
        // Only process inbound track (caller's voice)
        if (msg.media.track !== 'inbound') break;

        mediaCount++;
        if (mediaCount === 1) console.log('[STREAM] First inbound audio chunk received');

        const chunk = Buffer.from(msg.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          const capturedBuffer = audioBuffer;
          audioBuffer = Buffer.alloc(0);
          const durationMs = capturedBuffer.length / BYTES_PER_MS;
          console.log(`[STREAM] Silence detected — buffered ${Math.round(durationMs)}ms`);
          if (durationMs < MIN_AUDIO_MS) {
            console.log('[STREAM] Too short, skipping');
            return;
          }
          console.log(`[STREAM] Processing ${Math.round(durationMs)}ms of audio`);
          await processUtterance(capturedBuffer, callSid, streamSid);
        }, SILENCE_THRESHOLD_MS);
        break;
      }

      case 'stop':
        console.log(`[STREAM] Stopped — inbound chunks received: ${mediaCount}`);
        clearTimeout(silenceTimer);
        break;
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[STREAM] WebSocket closed — code: ${code}`);
    clearTimeout(silenceTimer);
    clearInterval(keepAliveInterval);
  });

  ws.on('error', (err) => {
    console.error('[STREAM] WebSocket error:', err.message);
    clearInterval(keepAliveInterval);
  });
}

async function processUtterance(mulawBuffer, callSid, streamSid) {
  const session = callSid ? sessionStore.get(callSid) : null;
  const callerLang = session?.callerLang || 'en';
  const targetLang = session?.targetLang || 'de';

  try {
    console.log('[PIPELINE] Transcribing...');
    const originalText = await transcribeAudio(mulawBuffer, callerLang);
    if (!originalText || originalText.trim().length < 2) {
      console.log('[PIPELINE] Empty transcription, skipping');
      return;
    }
    console.log(`[PIPELINE] Transcribed: "${originalText}"`);

    console.log('[PIPELINE] Translating...');
    const translatedText = await translateText(originalText, callerLang, targetLang);
    console.log(`[PIPELINE] Translated: "${translatedText}"`);

    console.log('[PIPELINE] Synthesizing speech...');
    const audioUrl = await synthesizeSpeech(translatedText, targetLang);
    console.log(`[PIPELINE] Audio ready: ${audioUrl}`);

    if (callSid && audioUrl) await injectAudioIntoCall(callSid, audioUrl);

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
