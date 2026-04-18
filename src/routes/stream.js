import { transcribeAudio } from '../services/whisper.js';
import { translateText } from '../services/translate.js';
import { synthesizeSpeech } from '../services/elevenlabs.js';
import { sessionStore } from '../services/sessionStore.js';
import { injectAudioIntoCall } from '../services/twilioClient.js';

function isSpeech(chunk) {
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) {
    energy += Math.abs(chunk[i] - 0xFF);
  }
  return (energy / chunk.length) > 2;
}

export function handleMediaStream(ws, req) {
  let callSid = null;
  let audioBuffer = Buffer.alloc(0);
  let streamSid = null;
  let keepAliveInterval = null;
  let processingInterval = null;
  let totalChunks = 0;
  let speechChunks = 0;

  const SAMPLE_RATE = 8000;
  const BYTES_PER_MS = SAMPLE_RATE / 1000;
  const MIN_AUDIO_MS = 500;
  const PROCESS_EVERY_MS = 5000;

  keepAliveInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 5000);

  processingInterval = setInterval(async () => {
    if (audioBuffer.length === 0) return;
    const capturedBuffer = audioBuffer;
    audioBuffer = Buffer.alloc(0);
    const durationMs = capturedBuffer.length / BYTES_PER_MS;
    if (durationMs < MIN_AUDIO_MS) return;
    console.log(`[STREAM] Flushing ${Math.round(durationMs)}ms of speech for processing`);
    await processUtterance(capturedBuffer, callSid, streamSid);
  }, PROCESS_EVERY_MS);

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
        console.log(`[STREAM] Started — CallSid: ${callSid}`);
        break;

      case 'media': {
        if (msg.media.track !== 'inbound') break;
        totalChunks++;
        const chunk = Buffer.from(msg.media.payload, 'base64');
        if (isSpeech(chunk)) {
          speechChunks++;
          audioBuffer = Buffer.concat([audioBuffer, chunk]);
        }
        break;
      }

      case 'stop':
        console.log(`[STREAM] Stopped — total: ${totalChunks}, speech: ${speechChunks}`);
        clearInterval(processingInterval);
        if (audioBuffer.length > 0) {
          const capturedBuffer = audioBuffer;
          audioBuffer = Buffer.alloc(0);
          const durationMs = capturedBuffer.length / BYTES_PER_MS;
          if (durationMs >= MIN_AUDIO_MS) {
            console.log(`[STREAM] Final flush: ${Math.round(durationMs)}ms`);
            await processUtterance(capturedBuffer, callSid, streamSid);
          }
        }
        break;
    }
  });

  ws.on('close', (code) => {
    console.log(`[STREAM] WebSocket closed — code: ${code}`);
    clearInterval(keepAliveInterval);
    clearInterval(processingInterval);
  });

  ws.on('error', (err) => {
    console.error('[STREAM] WebSocket error:', err.message);
    clearInterval(keepAliveInterval);
    clearInterval(processingInterval);
  });
}

async function processUtterance(mulawBuffer, callSid, streamSid) {
  const session = callSid ? sessionStore.get(callSid) : null;
  const callerLang = session?.callerLang || 'en';
  const targetLang = session?.targetLang || 'de';

  // Step 1: Transcribe
  let originalText;
  try {
    console.log('[PIPELINE] Transcribing...');
    originalText = await transcribeAudio(mulawBuffer, callerLang);
    if (!originalText || originalText.trim().length < 2) {
      console.log('[PIPELINE] Empty transcription, skipping');
      return;
    }
    console.log(`[PIPELINE] Transcribed: "${originalText}"`);
  } catch (err) {
    console.error('[PIPELINE] Transcription failed:', err.message);
    return;
  }

  // Step 2: Translate
  let translatedText;
  try {
    console.log('[PIPELINE] Translating...');
    translatedText = await translateText(originalText, callerLang, targetLang);
    console.log(`[PIPELINE] Translated: "${translatedText}"`);
  } catch (err) {
    console.error('[PIPELINE] Translation failed:', err.message);
    return;
  }

  // Step 3: TTS
  let audioUrl;
  try {
    console.log('[PIPELINE] Synthesizing speech...');
    audioUrl = await synthesizeSpeech(translatedText, targetLang);
    console.log(`[PIPELINE] Audio ready: ${audioUrl}`);
  } catch (err) {
    console.error('[PIPELINE] TTS failed:', err.message);
    return;
  }

  // Step 4: Inject into call
  try {
    if (callSid && audioUrl) {
      await injectAudioIntoCall(callSid, audioUrl);
    }
  } catch (err) {
    console.error('[PIPELINE] Inject failed:', err.message);
  }

  // Step 5: Save transcript
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
}
