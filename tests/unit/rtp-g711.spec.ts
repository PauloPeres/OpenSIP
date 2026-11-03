import { describe, expect, it } from 'vitest';
import {
  CLOCK_RATE,
  PCMA_PAYLOAD_TYPE,
  PCMU_PAYLOAD_TYPE,
  SAMPLES_PER_FRAME,
  decodeALaw,
  decodeMuLaw,
  encodeALaw,
  encodeMuLaw
} from '../../src/core/rtp/g711';

const pcm = (...samples: number[]): Int16Array => Int16Array.from(samples);
const bytes = (data: Uint8Array): number[] => Array.from(data);
const ints = (data: Int16Array): number[] => Array.from(data);

describe('constants', () => {
  it('match RFC 3551', () => {
    expect(PCMU_PAYLOAD_TYPE).toBe(0);
    expect(PCMA_PAYLOAD_TYPE).toBe(8);
    expect(CLOCK_RATE).toBe(8000);
    expect(SAMPLES_PER_FRAME).toBe(160);
  });
});

describe('encodeMuLaw', () => {
  it.each([
    [0, 0xff],
    [1, 0xff],
    [-1, 0x7f],
    [32767, 0x80],
    [-32768, 0x00],
    [8031, 0xa0],
    [-8031, 0x20],
    [33, 0xfb],
    [-33, 0x7b],
    [132, 0xef],
    [100, 0xf2],
    [255, 0xe7],
    [256, 0xe7],
    [1000, 0xce],
    [-1000, 0x4e]
  ])('encodes %i as 0x%s', (sample, byte) => {
    expect(bytes(encodeMuLaw(pcm(sample)))).toEqual([byte]);
  });

  it('encodes silence as 0xFF', () => {
    expect(bytes(encodeMuLaw(new Int16Array(SAMPLES_PER_FRAME)))).toEqual(
      new Array<number>(SAMPLES_PER_FRAME).fill(0xff)
    );
  });

  it('clips at 32635 and keeps the sign complement', () => {
    expect(bytes(encodeMuLaw(pcm(32635, 32636, 32767)))).toEqual([0x80, 0x80, 0x80]);
    expect(bytes(encodeMuLaw(pcm(-32635, -32768)))).toEqual([0x00, 0x00]);
  });

  it('returns an empty payload for empty input', () => {
    expect(encodeMuLaw(new Int16Array(0))).toHaveLength(0);
  });
});

describe('decodeMuLaw', () => {
  it.each([
    [0xff, 0],
    [0x7f, 0],
    [0x80, 32124],
    [0x00, -32124],
    [0xfe, 8],
    [0x7e, -8]
  ])('decodes 0x%s as %i', (byte, sample) => {
    expect(ints(decodeMuLaw(Uint8Array.of(byte)))).toEqual([sample]);
  });

  it('decodes a whole frame length', () => {
    expect(decodeMuLaw(new Uint8Array(SAMPLES_PER_FRAME).fill(0xff))).toHaveLength(160);
  });

  it('re-encodes every code to itself (except negative zero)', () => {
    for (let code = 0; code < 256; code += 1) {
      const expected = code === 0x7f ? 0xff : code;
      const again = encodeMuLaw(decodeMuLaw(Uint8Array.of(code)));
      expect(again[0]).toBe(expected);
    }
  });
});

describe('mu-law quantisation bounds', () => {
  it('keeps the round-trip error within the segment step over the full range', () => {
    for (let sample = -32768; sample <= 32767; sample += 1) {
      const out = decodeMuLaw(encodeMuLaw(pcm(sample)))[0] as number;
      const magnitude = Math.min(Math.abs(sample), 32635) + 132;
      const step = 2 ** (Math.floor(Math.log2(magnitude)) - 4);
      expect(Math.abs(out - Math.sign(sample) * Math.min(Math.abs(sample), 32635))).toBeLessThanOrEqual(step / 2 + 1);
    }
  });

  it('preserves the sign of every non-zero sample', () => {
    for (let sample = -32768; sample <= 32767; sample += 97) {
      const out = decodeMuLaw(encodeMuLaw(pcm(sample)))[0] as number;
      expect(Math.sign(out)).toBe(Math.sign(sample) === 0 ? 0 : Math.sign(sample));
    }
  });
});

describe('encodeALaw', () => {
  it.each([
    [0, 0xd5],
    [1, 0xd5],
    [-1, 0x55],
    [8, 0xd5],
    [-9, 0x55],
    [16, 0xd4],
    [32767, 0xaa],
    [-32768, 0x2a],
    [8031, 0x8a],
    [-8031, 0x0a],
    [100, 0xd3],
    [255, 0xda],
    [256, 0xc5],
    [1000, 0xfa],
    [-1000, 0x7a]
  ])('encodes %i as 0x%s', (sample, byte) => {
    expect(bytes(encodeALaw(pcm(sample)))).toEqual([byte]);
  });

  it('encodes silence as 0xD5', () => {
    expect(bytes(encodeALaw(new Int16Array(SAMPLES_PER_FRAME)))).toEqual(
      new Array<number>(SAMPLES_PER_FRAME).fill(0xd5)
    );
  });

  it('returns an empty payload for empty input', () => {
    expect(encodeALaw(new Int16Array(0))).toHaveLength(0);
  });
});

describe('decodeALaw', () => {
  it.each([
    [0xd5, 8],
    [0x55, -8],
    [0xaa, 32256],
    [0x2a, -32256],
    [0xd4, 24],
    [0xc5, 264]
  ])('decodes 0x%s as %i', (byte, sample) => {
    expect(ints(decodeALaw(Uint8Array.of(byte)))).toEqual([sample]);
  });

  it('re-encodes every code to itself', () => {
    for (let code = 0; code < 256; code += 1) {
      expect(encodeALaw(decodeALaw(Uint8Array.of(code)))[0]).toBe(code);
    }
  });

  it('keeps the round-trip error within the segment step over the full range', () => {
    for (let sample = -32768; sample <= 32767; sample += 1) {
      const out = decodeALaw(encodeALaw(pcm(sample)))[0] as number;
      const step = Math.max(16, 2 ** (Math.floor(Math.log2(Math.abs(sample) || 1)) - 4));
      expect(Math.abs(out - sample)).toBeLessThanOrEqual(step / 2 + 8);
    }
  });
});
