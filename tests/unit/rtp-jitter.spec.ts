import { describe, expect, it } from 'vitest';
import { createJitterBuffer } from '../../src/core/rtp/jitter';
import type { JitterBuffer } from '../../src/core/rtp/jitter';
import type { RtpPacket } from '../../src/core/rtp/packet';

const pkt = (seq: number): RtpPacket => ({
  header: {
    version: 2,
    padding: false,
    extension: false,
    csrcCount: 0,
    marker: false,
    payloadType: 0,
    sequenceNumber: seq,
    timestamp: seq * 160,
    ssrc: 1,
    csrc: []
  },
  payload: Uint8Array.of(seq & 0xff)
});
const feed = (buffer: JitterBuffer, ...seqs: number[]): void => seqs.forEach((s) => buffer.push(pkt(s)));
const pullSeq = (buffer: JitterBuffer): number | undefined => buffer.pull()?.header.sequenceNumber;
const pullAll = (buffer: JitterBuffer, count: number): (number | undefined)[] =>
  Array.from({ length: count }, () => pullSeq(buffer));

describe('prebuffering', () => {
  it('returns nothing until targetDepth frames are queued (default 3)', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 10, 11);
    expect(buffer.pull()).toBeUndefined();
    expect(buffer.depth).toBe(2);
    feed(buffer, 12);
    expect(pullAll(buffer, 3)).toEqual([10, 11, 12]);
  });

  it('honours a custom targetDepth', () => {
    const buffer = createJitterBuffer({ targetDepth: 1 });
    feed(buffer, 5);
    expect(pullSeq(buffer)).toBe(5);
  });

  it('keeps playing after the buffer drains below the target', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 3);
    expect(pullAll(buffer, 3)).toEqual([1, 2, 3]);
    feed(buffer, 4);
    expect(pullSeq(buffer)).toBe(4);
    expect(buffer.pull()).toBeUndefined();
  });

  it('reports depth as the number of queued frames', () => {
    const buffer = createJitterBuffer();
    expect(buffer.depth).toBe(0);
    feed(buffer, 1, 2, 3, 4);
    expect(buffer.depth).toBe(4);
    buffer.pull();
    expect(buffer.depth).toBe(3);
  });
});

describe('reordering and duplicates', () => {
  it('inserts an out-of-order packet in place and counts it as reordered', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 3, 4, 2);
    expect(pullAll(buffer, 4)).toEqual([1, 2, 3, 4]);
    expect(buffer.stats).toEqual({ received: 4, played: 4, lost: 0, duplicates: 0, reordered: 1 });
  });

  it('does not count in-order packets as reordered', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 3);
    expect(buffer.stats.reordered).toBe(0);
  });

  it('drops a duplicate still queued', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 2, 3);
    expect(pullAll(buffer, 3)).toEqual([1, 2, 3]);
    expect(buffer.stats.duplicates).toBe(1);
    expect(buffer.stats.received).toBe(4);
  });

  it('drops a packet that was already played', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 3);
    pullAll(buffer, 3);
    feed(buffer, 2, 3);
    expect(buffer.depth).toBe(0);
    expect(buffer.stats.duplicates).toBe(2);
  });

  it('drops a late packet whose slot was already declared lost', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 3, 4);
    expect(pullAll(buffer, 3)).toEqual([1, undefined, 3]);
    feed(buffer, 2);
    expect(buffer.depth).toBe(1);
    expect(buffer.stats.duplicates).toBe(1);
    expect(buffer.stats.reordered).toBe(0);
  });
});

describe('loss', () => {
  it('counts a gap as lost and yields undefined for that slot', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 4, 5);
    expect(pullAll(buffer, 4)).toEqual([1, 2, undefined, 4]);
    expect(buffer.stats.lost).toBe(1);
    expect(pullSeq(buffer)).toBe(5);
    expect(buffer.stats).toEqual({ received: 4, played: 4, lost: 1, duplicates: 0, reordered: 0 });
  });

  it('counts a wide gap one slot per pull', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 5);
    expect(pullAll(buffer, 5)).toEqual([1, 2, undefined, undefined, 5]);
    expect(buffer.stats.lost).toBe(2);
  });

  it('does not stall when the first packets are missing', () => {
    const buffer = createJitterBuffer({ targetDepth: 2 });
    feed(buffer, 100, 101);
    expect(pullAll(buffer, 2)).toEqual([100, 101]);
  });

  it('does not count a lost slot as played', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 3, 4);
    pullAll(buffer, 3);
    expect(buffer.stats.played).toBe(2);
  });

  it('waits (without counting loss) when nothing later is available', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 1, 2, 3);
    pullAll(buffer, 3);
    expect(buffer.pull()).toBeUndefined();
    expect(buffer.stats.lost).toBe(0);
    feed(buffer, 4);
    expect(pullSeq(buffer)).toBe(4);
  });
});

describe('maxDepth', () => {
  it('never exceeds maxDepth and discards the oldest', () => {
    const buffer = createJitterBuffer({ targetDepth: 2, maxDepth: 4 });
    feed(buffer, 1, 2, 3, 4, 5, 6);
    expect(buffer.depth).toBe(4);
    expect(pullAll(buffer, 4)).toEqual([3, 4, 5, 6]);
  });

  it('uses the default maxDepth of 10', () => {
    const buffer = createJitterBuffer();
    for (let seq = 1; seq <= 12; seq += 1) buffer.push(pkt(seq));
    expect(buffer.depth).toBe(10);
    expect(pullSeq(buffer)).toBe(3);
  });

  it('does not count discarded frames as lost or played', () => {
    const buffer = createJitterBuffer({ targetDepth: 1, maxDepth: 2 });
    feed(buffer, 1, 2, 3);
    expect(buffer.stats).toMatchObject({ lost: 0, played: 0, received: 3 });
  });
});

describe('sequence wrap', () => {
  it('plays across 65535 -> 0 in order', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 65534, 65535, 0, 1);
    expect(pullAll(buffer, 4)).toEqual([65534, 65535, 0, 1]);
  });

  it('reorders across the wrap', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 65534, 0, 1, 65535);
    expect(pullAll(buffer, 4)).toEqual([65534, 65535, 0, 1]);
    expect(buffer.stats.reordered).toBe(1);
  });

  it('detects loss across the wrap', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 65534, 0, 1);
    expect(pullAll(buffer, 3)).toEqual([65534, undefined, 0]);
    expect(buffer.stats.lost).toBe(1);
  });

  it('drops duplicates across the wrap', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 65535, 0, 1);
    pullAll(buffer, 3);
    feed(buffer, 65535, 0);
    expect(buffer.stats.duplicates).toBe(2);
  });
});

describe('discarding after playback started', () => {
  it('resumes at the oldest surviving frame without counting loss', () => {
    const buffer = createJitterBuffer({ targetDepth: 1, maxDepth: 2 });
    feed(buffer, 1);
    expect(pullSeq(buffer)).toBe(1);
    feed(buffer, 3, 4, 5);
    expect(pullAll(buffer, 2)).toEqual([4, 5]);
    expect(buffer.stats.lost).toBe(0);
  });
});
