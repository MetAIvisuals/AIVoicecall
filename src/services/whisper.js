import OpenAI from 'openai';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream } from 'fs';

let _openai = null;
function getClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export async function transcribeAudio(mulawBuffer, languageHint = 'en') {
  const tmpPath = join(tmpdir(), `utterance_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

  try {
    const wavBuffer = mulawToWav(mulawBuffer);
    writeFileSync(tmpPath, wavBuffer);

    console.log(`[WHISPER] Sending ${wavBuffer.length} bytes to Whisper, lang=${languageHint}`);

    const response = await getClient().audio.transcriptions.create({
      model: 'whisper-1',
      file: createReadStream(tmpPath),
      language: languageHint,
      response_format: 'text',
    });

    const text = typeof response === 'string' ? response.trim() : (response?.text?.trim() || '');
    console.log(`[WHISPER] Result: "${text}"`);
    return text;

  } catch (err) {
    console.error(`[WHISPER] Error: ${err.message}`);
    // Log more detail if available
    if (err.status) console.error(`[WHISPER] Status: ${err.status}, ${JSON.stringify(err.error)}`);
    throw err;
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
  }
}

function mulawToWav(mulawBuffer) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 8;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = mulawBuffer.length;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(7, 20);        // mulaw
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 36);
  wav.write('data', 38);
  wav.writeUInt32LE(dataSize, 42);
  mulawBuffer.copy(wav, headerSize);

  return wav;
}
