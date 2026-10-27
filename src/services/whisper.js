import OpenAI, { toFile } from 'openai';

let _openai = null;
function getClient() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: (process.env.OPENAI_API_KEY || '').trim(),
      maxRetries: 2,
      timeout: 30000,
    });
  }
  return _openai;
}

// Max 2 parallel Whisper requests
const MAX_CONCURRENT = 2;
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

export async function transcribeAudio(mulawBuffer, languageHint = 'en') {
  await acquire();
  try {
    const wavBuffer = mulawToPcmWav(mulawBuffer);
    console.log(`[WHISPER] Sending ${wavBuffer.length} bytes, lang=${languageHint}`);

    const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });
    const response = await getClient().audio.transcriptions.create({
      model: 'whisper-1',
      file,
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
    console.error(`[WHISPER] Key set: ${!!process.env.OPENAI_API_KEY}, length: ${(process.env.OPENAI_API_KEY || '').length}`);
    throw err;
  } finally {
    release();
  }
}

// Decode G.711 mulaw to 16-bit PCM and wrap in a standard WAV container
function mulawDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function mulawToPcmWav(mulawBuffer) {
  const sampleRate = 8000;
  const dataSize = mulawBuffer.length * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);           // PCM
  wav.writeUInt16LE(1, 22);           // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < mulawBuffer.length; i++) {
    wav.writeInt16LE(mulawDecode(mulawBuffer[i]), 44 + i * 2);
  }
  return wav;
}
