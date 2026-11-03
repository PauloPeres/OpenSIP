import { describe, expect, it } from 'vitest';
import {
  MalformedRtpPacketError,
  decodeRtp,
  encodeRtp,
  nextSequence,
  nextTimestamp,
  sequenceDelta
} from '../../src/core/rtp/packet';
import type { RtpHeader, RtpPacket } from '../../src/core/rtp/packet';

const header = (overrides: Partial<RtpHeader> = {}): RtpHeader => ({
  version: 2,
  padding: false,
  extension: false,
  csrcCount: 0,
  marker: false,
  payloadType: 0,
  sequenceNumber: 0,
  timestamp: 0,
  ssrc: 0,
  csrc: [],
  ...overrides
});
const packet = (overrides: Partial<RtpHeader> = {}, payload: number[] = []): RtpPacket => ({
  header: header(overrides),
  payload: Uint8Array.from(payload)
});
const bytes = (data: Uint8Array): number[] => Array.from(data);

describe('encodeRtp header layout', () => {
  it('writes a plain 12-byte header bit by bit', () => {
    const out = encodeRtp(
      packet({ marker: true, payloadType: 8, sequenceNumber: 0x1234, timestamp: 0x01020304, ssrc: 0xa1b2c3d4 }, [9, 8])
    );
    expect(bytes(out)).toEqual([0x80, 0x88, 0x12, 0x34, 0x01, 0x02, 0x03, 0x04, 0xa1, 0xb2, 0xc3, 0xd4, 9, 8]);
  });

  it('sets the padding flag in bit 5 of byte 0', () => {
    expect(encodeRtp(packet({ padding: true }))[0]).toBe(0xa0);
  });

  it('sets the extension flag in bit 4 of byte 0', () => {
    expect(encodeRtp(packet({ extension: true }))[0]).toBe(0x90);
  });

  it('puts the csrc count in the low nibble and appends the list', () => {
    const out = encodeRtp(packet({ csrcCount: 2, csrc: [0x01020304, 0xffffffff] }, [7]));
    expect(out[0]).toBe(0x82);
    expect(bytes(out.subarray(12))).toEqual([1, 2, 3, 4, 255, 255, 255, 255, 7]);
  });

  it('clears the marker bit and keeps the payload type in the low 7 bits', () => {
    expect(encodeRtp(packet({ payloadType: 127 }))[1]).toBe(0x7f);
    expect(encodeRtp(packet({ payloadType: 127, marker: true }))[1]).toBe(0xff);
    expect(encodeRtp(packet({ payloadType: 0, marker: true }))[1]).toBe(0x80);
  });

  it('encodes maximum field values', () => {
    const out = encodeRtp(packet({ sequenceNumber: 65535, timestamp: 4294967295, ssrc: 4294967295 }));
    expect(bytes(out.subarray(2))).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  });

  it('rejects a payload type above 127', () => {
    expect(() => encodeRtp(packet({ payloadType: 128 }))).toThrow(MalformedRtpPacketError);
    expect(() => encodeRtp(packet({ payloadType: -1 }))).toThrow(MalformedRtpPacketError);
  });

  it('rejects a csrc count that disagrees with the list or exceeds 15', () => {
    expect(() => encodeRtp(packet({ csrcCount: 1, csrc: [] }))).toThrow(MalformedRtpPacketError);
    const many = new Array<number>(16).fill(1);
    expect(() => encodeRtp(packet({ csrcCount: 16, csrc: many }))).toThrow(MalformedRtpPacketError);
  });
});

describe('decodeRtp', () => {
  it('reads every header field', () => {
    const out = decodeRtp(
      Uint8Array.of(0xb2, 0x88, 0x12, 0x34, 0x01, 0x02, 0x03, 0x04, 0xa1, 0xb2, 0xc3, 0xd4, 0, 0, 0, 0, 0, 0, 0, 5, 9, 8, 7)
    );
    expect(out.header).toEqual({
      version: 2,
      padding: true,
      extension: true,
      csrcCount: 2,
      marker: true,
      payloadType: 8,
      sequenceNumber: 0x1234,
      timestamp: 0x01020304,
      ssrc: 0xa1b2c3d4,
      csrc: [0, 5]
    });
  });
});

describe('decodeRtp (continued)', () => {
  it('reads the payload after the header', () => {
    const out = decodeRtp(Uint8Array.of(0x80, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 4, 5, 6));
    expect(bytes(out.payload)).toEqual([4, 5, 6]);
    expect(out.header.sequenceNumber).toBe(1);
    expect(out.header.timestamp).toBe(2);
    expect(out.header.ssrc).toBe(3);
  });

  it('accepts a header-only packet with an empty payload', () => {
    expect(decodeRtp(new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).payload).toHaveLength(0);
  });

  it('reads unsigned 32-bit values above 2^31', () => {
    const out = decodeRtp(Uint8Array.of(0x80, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x80, 0, 0, 0));
    expect(out.header.timestamp).toBe(4294967295);
    expect(out.header.ssrc).toBe(0x80000000);
    expect(out.header.sequenceNumber).toBe(65535);
  });

  it('rejects a buffer shorter than 12 bytes', () => {
    expect(() => decodeRtp(new Uint8Array(11))).toThrow(MalformedRtpPacketError);
    expect(() => decodeRtp(new Uint8Array(0))).toThrow(MalformedRtpPacketError);
  });

  it('rejects a version other than 2', () => {
    expect(() => decodeRtp(Uint8Array.of(0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(MalformedRtpPacketError);
  });

  it('rejects a buffer too short for its csrc list', () => {
    expect(() => decodeRtp(Uint8Array.of(0x81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3))).toThrow(
      MalformedRtpPacketError
    );
  });

  it('round-trips an encoded packet and copies the payload', () => {
    const original = packet({ marker: true, csrcCount: 1, csrc: [42], sequenceNumber: 7, ssrc: 9 }, [1, 2, 3]);
    const wire = encodeRtp(original);
    const decoded = decodeRtp(wire);
    expect(decoded).toEqual(original);
    wire[wire.length - 1] = 99;
    expect(bytes(decoded.payload)).toEqual([1, 2, 3]);
  });

  it('carries the error name as a short identifier', () => {
    try {
      decodeRtp(new Uint8Array(3));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: 'MalformedRtpPacketError', message: 'malformed-rtp-packet' });
    }
  });
});

describe('wrap arithmetic', () => {
  it('nextSequence increments and wraps at 16 bits', () => {
    expect(nextSequence(0)).toBe(1);
    expect(nextSequence(65534)).toBe(65535);
    expect(nextSequence(65535)).toBe(0);
  });

  it('nextTimestamp advances and wraps at 32 bits', () => {
    expect(nextTimestamp(0, 160)).toBe(160);
    expect(nextTimestamp(4294967295, 160)).toBe(159);
    expect(nextTimestamp(4294967136, 160)).toBe(0);
    expect(nextTimestamp(4294967135, 160)).toBe(4294967295);
  });

  it('sequenceDelta is the shortest signed distance', () => {
    expect(sequenceDelta(5, 5)).toBe(0);
    expect(sequenceDelta(6, 5)).toBe(1);
    expect(sequenceDelta(5, 6)).toBe(-1);
    expect(sequenceDelta(0, 65535)).toBe(1);
    expect(sequenceDelta(65535, 0)).toBe(-1);
    expect(sequenceDelta(2, 65534)).toBe(4);
    expect(sequenceDelta(65534, 2)).toBe(-4);
  });

  it('sequenceDelta resolves the half-range boundary', () => {
    expect(sequenceDelta(32767, 0)).toBe(32767);
    expect(sequenceDelta(32768, 0)).toBe(-32768);
    expect(sequenceDelta(0, 32768)).toBe(-32768);
    expect(sequenceDelta(0, 32767)).toBe(-32767);
  });
});
