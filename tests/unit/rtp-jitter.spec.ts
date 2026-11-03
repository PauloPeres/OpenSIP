import { describe, expect, it } from 'vitest';
import { SEQUENCE_JUMP_THRESHOLD, createJitterBuffer } from '../../src/core/rtp/jitter';
import type { JitterBuffer } from '../../src/core/rtp/jitter';
import type { RtpPacket } from '../../src/core/rtp/packet';

const pkt = (seq: number, ssrc = 1): RtpPacket => ({
  header: {
    version: 2,
    padding: false,
    extension: false,
    csrcCount: 0,
    marker: false,
    payloadType: 0,
    sequenceNumber: seq,
    timestamp: seq * 160,
    ssrc,
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

/** Plays `ticks` 20 ms ticks, pushing one packet per tick from `next`, and returns how many ticks produced audio. */
function audibleTicks(buffer: JitterBuffer, ticks: number, next: (tick: number) => RtpPacket): number {
  let audible = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    buffer.push(next(tick));
    if (buffer.pull() !== undefined) audible += 1;
  }
  return audible;
}

describe('stream re-base (new SSRC)', () => {
  const established = (): JitterBuffer => {
    const buffer = createJitterBuffer();
    audibleTicks(buffer, 1000, (tick) => pkt(1000 + tick, 1));
    return buffer;
  };

  it('REPRODUCTION: plays promptly when a new SSRC starts 900 sequence numbers behind the cursor', () => {
    const buffer = established();
    const audible = audibleTicks(buffer, 100, (tick) => pkt(100 + tick, 2));
    // Before the fix this was 0 for 18 seconds (900 ticks); with it, only the re-prebuffer gap is silent.
    expect(audible).toBeGreaterThan(90);
  });

  it('plays promptly when the new SSRC starts about 30000 behind the cursor', () => {
    const buffer = established();
    const audible = audibleTicks(buffer, 100, (tick) => pkt(1000 + tick - 30_000 + 65_536, 2));
    expect(audible).toBeGreaterThan(90);
  });

  it('plays promptly when the new SSRC starts far ahead of the cursor', () => {
    const buffer = established();
    const audible = audibleTicks(buffer, 100, (tick) => pkt(5000 + tick, 2));
    expect(audible).toBeGreaterThan(90);
  });

  it('plays the new stream in order, without the old one leaking in, and counts the resync', () => {
    const buffer = established();
    buffer.push(pkt(50, 2));
    buffer.push(pkt(51, 2));
    buffer.push(pkt(52, 2));
    expect(buffer.resyncs).toBe(1);
    expect(pullAll(buffer, 3)).toEqual([50, 51, 52]);
  });

  it('does not resync on a single packet of another SSRC (a stray cannot hijack playback)', () => {
    const buffer = established();
    buffer.push(pkt(50, 2));
    expect(buffer.resyncs).toBe(0);
    buffer.push(pkt(2000, 1));
    buffer.push(pkt(2001, 1));
    buffer.push(pkt(2002, 1));
    expect(buffer.resyncs).toBe(0);
    expect(pullAll(buffer, 5)).toEqual([1998, 1999, 2000, 2001, 2002]);
  });

  it('needs two strays from the same SSRC and consecutive in sequence', () => {
    const buffer = established();
    buffer.push(pkt(50, 2));
    buffer.push(pkt(52, 2));
    buffer.push(pkt(53, 3));
    expect(buffer.resyncs).toBe(0);
    buffer.push(pkt(54, 3));
    expect(buffer.resyncs).toBe(1);
  });

  it('resyncs on an SSRC change even when the new sequence numbers sit right next to the old ones', () => {
    const buffer = established();
    buffer.push(pkt(2000, 2));
    expect(buffer.resyncs).toBe(0);
    buffer.push(pkt(2001, 2));
    expect(buffer.resyncs).toBe(1);
    expect(buffer.depth).toBe(2);
  });

  it('forgets a lone stray as soon as the real stream is heard again', () => {
    const buffer = established();
    buffer.push(pkt(50, 2));
    buffer.push(pkt(2000, 1));
    buffer.push(pkt(51, 2));
    expect(buffer.resyncs).toBe(0);
  });

  it('accepts the very first packet of any SSRC', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 7);
    expect(buffer.depth).toBe(1);
    expect(buffer.resyncs).toBe(0);
  });
});

describe('sequence jump within one SSRC', () => {
  const jumpBy = (offset: number): JitterBuffer => {
    const buffer = createJitterBuffer();
    feed(buffer, 1000, 1001, 1002);
    pullAll(buffer, 3);
    buffer.push(pkt(1002 + offset));
    buffer.push(pkt(1003 + offset));
    return buffer;
  };

  it('exposes the threshold as 100 packets (2 s at 20 ms)', () => {
    expect(SEQUENCE_JUMP_THRESHOLD).toBe(100);
  });

  it('treats a forward jump of exactly the threshold as loss, not a restart', () => {
    expect(jumpBy(SEQUENCE_JUMP_THRESHOLD).resyncs).toBe(0);
  });

  it('treats a forward jump one beyond the threshold as a restart', () => {
    expect(jumpBy(SEQUENCE_JUMP_THRESHOLD + 1).resyncs).toBe(1);
  });

  it('treats a backward jump of exactly the threshold as stale, not a restart', () => {
    expect(jumpBy(-SEQUENCE_JUMP_THRESHOLD).resyncs).toBe(0);
  });

  it('treats a backward jump one beyond the threshold as a restart', () => {
    expect(jumpBy(-SEQUENCE_JUMP_THRESHOLD - 1).resyncs).toBe(1);
  });

  it('plays promptly after a large forward jump instead of stalling', () => {
    const buffer = createJitterBuffer();
    audibleTicks(buffer, 200, (tick) => pkt(tick));
    expect(audibleTicks(buffer, 60, (tick) => pkt(5000 + tick))).toBeGreaterThan(50);
  });

  it('measures the jump across the 16-bit wrap', () => {
    const buffer = createJitterBuffer();
    feed(buffer, 65_530, 65_531, 65_532);
    pullAll(buffer, 3);
    feed(buffer, 60, 61);
    expect(buffer.resyncs).toBe(0);
  });
});
