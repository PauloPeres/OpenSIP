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
import {
  LATCH_CONFIRMATIONS,
  WATCHDOG_START,
  latchObserve,
  latchStart,
  latchTick,
  timeoutTicks,
  watchdogHeard,
  watchdogTick
} from '../../src/core/rtp/flow';
import type { LatchState } from '../../src/core/rtp/flow';
import {
  MAX_PAYLOAD_BYTES,
  PAYLOAD_GRANULE_BYTES,
  createFrameAssembler,
  isPlayablePayload
} from '../../src/core/rtp/playout';

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

/* ---------------------------------------------- payload framing and flow rules */

describe('isPlayablePayload', () => {
  it.each([80, 160, 240, 320, 960])('accepts %i bytes', (bytes) => expect(isPlayablePayload(bytes)).toBe(true));
  it.each([0, 1, 79, 81, 100, 159, 161, 1040])('rejects %i bytes', (bytes) => expect(isPlayablePayload(bytes)).toBe(false));
  it('rejects one granule above the maximum and accepts the maximum', () => {
    expect(isPlayablePayload(MAX_PAYLOAD_BYTES)).toBe(true);
    expect(isPlayablePayload(MAX_PAYLOAD_BYTES + PAYLOAD_GRANULE_BYTES)).toBe(false);
    expect(isPlayablePayload(PAYLOAD_GRANULE_BYTES - 1)).toBe(false);
  });
});

describe('createFrameAssembler', () => {
  const ramp = (n: number, from = 1): Int16Array => Int16Array.from({ length: n }, (_, i) => from + i);

  it('starts hungry and is fed by 10 ms packets two at a time', () => {
    const assembler = createFrameAssembler();
    expect(assembler.hungry).toBe(true);
    assembler.append(ramp(80));
    expect(assembler.hungry).toBe(true);
    assembler.append(ramp(80, 81));
    expect(assembler.hungry).toBe(false);
    expect([...assembler.take()]).toEqual([...ramp(160)]);
    expect(assembler.hungry).toBe(true);
  });

  it('splits a 40 ms packet across two takes without pulling again', () => {
    const assembler = createFrameAssembler();
    assembler.append(ramp(320));
    expect([...assembler.take()]).toEqual([...ramp(160)]);
    expect(assembler.hungry).toBe(false);
    expect([...assembler.take()]).toEqual([...ramp(160, 161)]);
  });

  it('pads a short queue with silence', () => {
    const assembler = createFrameAssembler();
    assembler.append(ramp(100));
    const frame = assembler.take();
    expect(frame).toHaveLength(160);
    expect([...frame.subarray(0, 100)]).toEqual([...ramp(100)]);
    expect(frame.subarray(100).every((v) => v === 0)).toBe(true);
  });

  it('conceals a gap with 20 ms until a packet size is known, then with that size', () => {
    const assembler = createFrameAssembler();
    assembler.conceal();
    expect(assembler.hungry).toBe(false);
    assembler.take();
    assembler.append(ramp(320));
    assembler.take();
    assembler.take();
    assembler.conceal();
    expect(assembler.take().every((v) => v === 0)).toBe(true);
    expect(assembler.hungry).toBe(false);
    assembler.take();
    expect(assembler.hungry).toBe(true);
  });
});

describe('watchdog', () => {
  it('converts a timeout to ticks, rounding up and never below one', () => {
    expect(timeoutTicks(30_000)).toBe(1500);
    expect(timeoutTicks(21)).toBe(2);
    expect(timeoutTicks(20)).toBe(1);
    expect(timeoutTicks(0)).toBe(1);
  });

  it('raises stalled exactly on the limit tick, once', () => {
    let step = watchdogTick(WATCHDOG_START, 3);
    step = watchdogTick(step.state, 3);
    expect(step.event).toBeUndefined();
    step = watchdogTick(step.state, 3);
    expect(step.event).toBe('stalled');
    expect(watchdogTick(step.state, 3).event).toBeUndefined();
  });

  it('raises resumed only after an alarm', () => {
    expect(watchdogHeard(WATCHDOG_START)).toEqual({ state: WATCHDOG_START });
    const alarmed = { quiet: 9, alarmed: true };
    expect(watchdogHeard(alarmed)).toEqual({ state: WATCHDOG_START, event: 'resumed' });
  });
});

describe('latching', () => {
  const target = { host: '10.0.0.1', port: 4000 };
  const nat = { host: '203.0.113.5', port: 51_000 };
  const see = (state: LatchState, source = nat, sequence = 0, ssrc = 1): LatchState =>
    latchObserve(state, { source, ssrc, sequence });
  const run = (state: LatchState, count: number, from = 0): LatchState => {
    let next = state;
    for (let i = 0; i < count; i += 1) next = see(next, nat, (from + i) & 0xffff);
    return next;
  };

  it('latches at LATCH_CONFIRMATIONS and not before', () => {
    expect(run(latchStart(target), LATCH_CONFIRMATIONS - 1).target).toEqual(target);
    const latched = run(latchStart(target), LATCH_CONFIRMATIONS);
    expect(latched.target).toEqual(nat);
    expect(latched.settled).toBe(true);
  });

  it('counts sequence numbers across the 16-bit wrap', () => {
    expect(run(latchStart(target), LATCH_CONFIRMATIONS, 65_533).target).toEqual(nat);
  });

  it('settles on the first packet from the advertised address and then never moves', () => {
    const settled = see(latchStart(target), target);
    expect(settled.settled).toBe(true);
    expect(run(settled, 50).target).toEqual(target);
  });

  it('distinguishes host from port', () => {
    const samePort = { host: '203.0.113.5', port: 4000 };
    const sameHost = { host: '10.0.0.1', port: 4001 };
    expect(see(latchStart(target), samePort).settled).toBe(false);
    expect(see(latchStart(target), sameHost).settled).toBe(false);
  });

  it('restarts the count for a different source, SSRC, or a non-consecutive sequence', () => {
    const base = run(latchStart(target), 3);
    expect(see(base, { ...nat, port: nat.port + 1 }, 3).candidate?.count).toBe(1);
    expect(see(base, nat, 3, 2).candidate?.count).toBe(1);
    expect(see(base, nat, 4).candidate?.count).toBe(1);
    expect(see(base, nat, 3).candidate?.count).toBe(4);
  });

  it('closes the window after windowTicks and ignores later packets', () => {
    let state = latchStart(target);
    state = latchTick(state, 3);
    state = latchTick(state, 3);
    expect(state.settled).toBe(false);
    state = latchTick(state, 3);
    expect(state.settled).toBe(true);
    expect(run(state, 20).target).toEqual(target);
  });

  it('keeps a settled state settled as time passes', () => {
    expect(latchTick({ target, settled: true, age: 0 }, 99).settled).toBe(true);
  });
});
