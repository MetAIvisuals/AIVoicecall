import OpenAI, { toFile } from 'openai';

let _openai = null;
function getClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 3, timeout: 30000 });
  return _openai;
}

const MAX_PARALLEL = 2;
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

export async function transcribeAudio(mulawBuffer, languageHint = 'en') {
  await acquire();
  try {
    const wavBuffer = mulawToWav(mulawBuffer);
    console.log(`[WHISPER] Sending ${wavBuffer.length} bytes to Whisper, lang=${languageHint}`);

    const response = await getClient().audio.transcriptions.create({
      model: 'whisper-1',
      file: await toFile(wavBuffer, 'utterance.wav', { type: 'audio/wav' }),
      language: languageHint,
      response_format: 'text',
    });

    const text = typeof response === 'string' ? response.trim() : (response?.text?.trim() || '');
    console.log(`[WHISPER] Result: "${text}"`);
    return text;
  } catch (err) {
    console.error(`[WHISPER] Error: ${err.message}`);
    if (err.status) console.error(`[WHISPER] Status: ${err.status}, ${JSON.stringify(err.error)}`);
    if (err.cause) console.error(`[WHISPER] Cause: ${err.cause.code || ''} ${err.cause.message || err.cause}`);
    if (!process.env.OPENAI_API_KEY) console.error('[WHISPER] OPENAI_API_KEY is not set');
    throw err;
  } finally {
    release();
  }
}

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

// 8 kHz mulaw -> 16 kHz 16-bit PCM WAV (linear interpolation upsampling)
function mulawToWav(mulawBuffer) {
  const n = mulawBuffer.length;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const cur = MULAW_DECODE[mulawBuffer[i]];
    const next = i + 1 < n ? MULAW_DECODE[mulawBuffer[i + 1]] : cur;
    pcm.writeInt16LE(cur, i * 4);
    pcm.writeInt16LE((cur + next) >> 1, i * 4 + 2);
  }

  const sampleRate = 16000;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);              // PCM
  wav.writeUInt16LE(1, 22);              // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
