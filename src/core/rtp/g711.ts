export const PCMU_PAYLOAD_TYPE = 0;
export const PCMA_PAYLOAD_TYPE = 8;
export const CLOCK_RATE = 8000;
/** 20 ms of audio at 8 kHz. */
export const SAMPLES_PER_FRAME = 160;

const MU_BIAS = 0x84;
const MU_CLIP = 32635;
const A_OVERFLOW_SEGMENT = 8;

function muLawByte(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(sample), MU_CLIP) + MU_BIAS;
  const exponent = 31 - Math.clz32(magnitude) - 7;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawSample(byte: number): number {
  const code = ~byte & 0xff;
  const exponent = (code >> 4) & 0x07;
  const magnitude = (((code & 0x0f) << 3) + MU_BIAS) * 2 ** exponent - MU_BIAS;
  return (code & 0x80) === 0 ? magnitude : -magnitude;
}

function aLawByte(sample: number): number {
  const positive = sample >= 0;
  const mask = positive ? 0xd5 : 0x55;
  const level = positive ? sample >> 3 : ~sample >> 3;
  const segment = 32 - Math.clz32(level >> 5);
  if (segment >= A_OVERFLOW_SEGMENT) return 0x7f ^ mask;
  const mantissa = (level >> Math.max(segment, 1)) & 0x0f;
  return ((segment << 4) | mantissa) ^ mask;
}

function aLawSample(byte: number): number {
  const code = byte ^ 0x55;
  const segment = (code >> 4) & 0x07;
  const base = ((code & 0x0f) << 4) + 8 + (segment > 0 ? 0x100 : 0);
  const magnitude = base * 2 ** Math.max(segment - 1, 0);
  return (code & 0x80) === 0 ? -magnitude : magnitude;
}

export function encodeMuLaw(pcm: Int16Array): Uint8Array {
  return Uint8Array.from(pcm, muLawByte);
}

export function decodeMuLaw(payload: Uint8Array): Int16Array {
  return Int16Array.from(payload, muLawSample);
}

export function encodeALaw(pcm: Int16Array): Uint8Array {
  return Uint8Array.from(pcm, aLawByte);
}

export function decodeALaw(payload: Uint8Array): Int16Array {
  return Int16Array.from(payload, aLawSample);
}
