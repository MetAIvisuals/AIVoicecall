// Twilio 8 kHz mulaw <-> PCM16 helpers
export const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

export function mulawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

// streaming 24 kHz PCM16 (bytes) -> 8 kHz Int16Array (average of 3 = simple low-pass)
export function makeDownsampler24to8() {
  let rest = Buffer.alloc(0);
  return (pcm24) => {
    const buf = rest.length ? Buffer.concat([rest, pcm24]) : pcm24;
    const frames = Math.floor(buf.length / 6);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = Math.round((buf.readInt16LE(i * 6) + buf.readInt16LE(i * 6 + 2) + buf.readInt16LE(i * 6 + 4)) / 3);
    }
    rest = buf.subarray(frames * 6);
    return out;
  };
}
