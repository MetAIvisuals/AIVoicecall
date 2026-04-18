import { transcribeAudio } from '../services/whisper.js';
import { translateText } from '../services/translate.js';
import { synthesizeSpeech } from '../services/elevenlabs.js';
import { sessionStore } from '../services/sessionStore.js';
import { injectAudioIntoCall } from '../services/twilioClient.js';

// Detect if a mulaw chunk contains actual speech vs silence
// mulaw silence is encoded as 0xFF (127 in signed) — check average energy
function isSpeech(chunk) {
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) {
    // mulaw 0xFF = silence, deviation from 0xFF = sound
    energy += Math.abs(chunk[i] - 0xFF);
  }
  const avgEnergy = energy / chunk.length;
  return avgEnergy > 2; // threshold — above 2 = speech detected
}

export function handleMediaStream(ws, req) {
  let callSid = null;
  let audioBuffer = Buffer.alloc(0);
  let silenceTimer = null;
  let streamSid = null;
  let keepAliveInterval = null;
  let mediaCount = 0;
  let speechChunks = 0;
  let isSpeaking = false;

  const SILENCE_THRESHOLD_MS = 1000; // stop collecting after 1s of silence
  const MIN_AUDIO_MS = 300;
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
        console.log(`[STREAM] Started — CallSid: ${callSid}`);
        break;

      case 'media': {
        if (msg.media.track !== 'inbound') break;

        mediaCount++;
        const chunk = Buffer.from(msg.media.payload, 'base64');
        const speaking = isSpeech(chunk);

        if (speaking) {
          if (!isSpeaking) {
            console.log('[STREAM] Speech started');
            isSpeaking = true;
          }
          speechChunks++;
          audioBuffer = Buffer.concat([audioBuffer, chunk]);

          // Reset silence timer whenever speech is detected
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(async () => {
            isSpeaking = false;
            const capturedBuffer = audioBuffer;
            audioBuffer = Buffer.alloc(0);
            const durationMs = capturedBuffer.length / BYTES_PER_MS;
            console.log(`[STREAM] Speech ended — ${Math.round(durationMs)}ms captured`);
            if (durationMs < MIN_AUDIO_MS) return;
            await processUtterance(capturedBuffer, callSid, streamSid);
          }, SILENCE_THRESHOLD_MS);
        }
        break;
      }

      case 'stop':
        console.log(`[STREAM] Stopped — total: ${mediaCount} chunks, speech: ${speechChunks} chunks`);
        clearTimeout(silenceTimer);
        // Process any remaining buffered speech
        if (audioBuffer.length > 0) {
          const capturedBuffer = audioBuffer;
          audioBuffer = Buffer.alloc(0);
          const durationMs = capturedBuffer.length / BYTES_PER_MS;
          if (durationMs >= MIN_AUDIO_MS) {
            console.log(`[STREAM] Processing remaining ${Math.round(durationMs)}ms on stop`);
            await processUtterance(capturedBuffer, callSid, streamSid);
          }
        }
        break;
    }
  });

  ws.on('close', (code) => {
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
