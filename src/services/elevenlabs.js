import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '../../audio_cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ElevenLabs voice IDs per language — multilingual v2 model
const VOICE_MAP = {
  de: process.env.ELEVENLABS_VOICE_DE || 'pNInz6obpgDQGcFmaJgB', // Adam (multilingual)
  en: process.env.ELEVENLABS_VOICE_EN || 'EXAVITQu4vr4xnSDxMaL', // Bella
  fr: process.env.ELEVENLABS_VOICE_FR || 'pNInz6obpgDQGcFmaJgB',
  es: process.env.ELEVENLABS_VOICE_ES || 'pNInz6obpgDQGcFmaJgB',
  default: process.env.ELEVENLABS_VOICE_DE || 'pNInz6obpgDQGcFmaJgB',
};

/**
 * Streams TTS audio from ElevenLabs using the /stream endpoint.
 *
 * Strategy:
 *  1. Open a streaming request to ElevenLabs.
 *  2. Pipe chunks to disk as they arrive (first-chunk latency ~300–600ms).
 *  3. Once the file exists on disk and has enough data for Twilio to start
 *     playing, resolve the promise with the public URL.
 *  4. Continue writing remaining chunks in the background.
 *
 * This means Twilio starts fetching/playing the MP3 while ElevenLabs
 * is still generating the tail — cutting perceived latency significantly.
 */
export async function synthesizeSpeech(text, lang = 'de') {
  const voiceId = VOICE_MAP[lang] || VOICE_MAP.default;
  const cacheKey = createHash('md5').update(`${voiceId}:${text}`).digest('hex');
  const fileName = `${cacheKey}.mp3`;
  const filePath = join(CACHE_DIR, fileName);
  const publicUrl = `${process.env.SERVER_URL}/audio/${fileName}`;

  // Full cache hit — return immediately
  if (existsSync(filePath)) {
    console.log(`[TTS] Cache hit: "${text.substring(0, 40)}"`);
    return publicUrl;
  }

  console.log(`[TTS] Streaming synthesis: "${text.substring(0, 60)}"`);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        optimize_streaming_latency: 3, // 0–4; higher = lower latency, slightly lower quality
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs error ${response.status}: ${err}`);
  }

  // Stream to disk; resolve as soon as the file has enough bytes for Twilio
  // to start buffering (we use 8KB as the trigger — roughly 0.5s of audio).
  const EARLY_RESOLVE_BYTES = 8 * 1024;
  const writer = createWriteStream(filePath);
  let bytesWritten = 0;
  let resolved = false;

  return new Promise((resolve, reject) => {
    response.body.on('data', (chunk) => {
      writer.write(chunk);
      bytesWritten += chunk.length;

      if (!resolved && bytesWritten >= EARLY_RESOLVE_BYTES) {
        resolved = true;
        console.log(`[TTS] Early resolve at ${bytesWritten} bytes — Twilio can start playing`);
        resolve(publicUrl); // resolve early; writing continues in background
      }
    });

    response.body.on('end', () => {
      writer.end();
      if (!resolved) {
        // Short text finished before hitting threshold — resolve now
        resolved = true;
        resolve(publicUrl);
      }
      console.log(`[TTS] Stream complete — ${bytesWritten} bytes total`);
    });

    response.body.on('error', (err) => {
      writer.destroy();
      if (!resolved) reject(err);
      else console.error('[TTS] Stream error after early resolve:', err.message);
    });
  });
}
