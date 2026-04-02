import OpenAI from 'openai';
import { Readable } from 'stream';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let _openai = null;
function getClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * Transcribes a mulaw audio buffer using OpenAI Whisper.
 * Twilio sends audio as 8kHz mulaw — we write it to a temp WAV file
 * with the correct headers before sending to Whisper.
 */
export async function transcribeAudio(mulawBuffer, languageHint = 'en') {
  const wavBuffer = mulawToWav(mulawBuffer);
  const tmpPath = join(tmpdir(), `utterance_${Date.now()}.wav`);

  try {
    writeFileSync(tmpPath, wavBuffer);

    const file = await OpenAI.toFile(
      Readable.from(wavBuffer),
      'audio.wav',
      { type: 'audio/wav' }
    );

    const response = await getClient().audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: languageHint,
      response_format: 'text',
    });

    return typeof response === 'string' ? response.trim() : response?.text?.trim() || '';
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Converts raw 8kHz mulaw PCM to a WAV file buffer.
 * WAV header = 44 bytes. mulaw samples are 8-bit.
 */
function mulawToWav(mulawBuffer) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 8;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = mulawBuffer.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF chunk
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);

  // fmt chunk — PCM mulaw = audioFormat 7
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);        // chunk size
  wav.writeUInt16LE(7, 20);         // audio format: mulaw
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 36);

  // data chunk
  wav.write('data', 38);
  wav.writeUInt32LE(dataSize, 42);
  mulawBuffer.copy(wav, headerSize);

  return wav;
}
