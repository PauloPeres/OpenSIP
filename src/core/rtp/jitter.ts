import { nextSequence, sequenceDelta } from './packet';
import type { RtpPacket } from './packet';

export interface JitterOptions {
  /** Frames to queue before the first pull returns audio. */
  readonly targetDepth: number;
  /** Hard cap on queued frames; the oldest are discarded beyond it. */
  readonly maxDepth: number;
}

export interface JitterStats {
  readonly received: number;
  readonly played: number;
  readonly lost: number;
  readonly duplicates: number;
  readonly reordered: number;
}

export interface JitterBuffer {
  push(packet: RtpPacket): void;
  /** Returns the next frame to play, or undefined to play comfort silence. */
  pull(): RtpPacket | undefined;
  readonly stats: JitterStats;
  readonly depth: number;
  /** How many times the buffer abandoned a stream and started over on another (SSRC change or sequence jump). */
  readonly resyncs: number;
}

/**
 * A packet further than this many sequence numbers from the last one accepted
 * is not reordering but a different stream (a restart or re-base). 100 is
 * RFC 3550 appendix A.1's MAX_MISORDER: two seconds at 20 ms, ten times the
 * deepest queue we keep, so nothing beyond it could ever be played in order.
 * A genuine loss burst of more than 100 packets resyncs too, which costs no
 * more than the silence it would have played anyway.
 */
export const SEQUENCE_JUMP_THRESHOLD = 100;

const DEFAULTS: JitterOptions = { targetDepth: 3, maxDepth: 10 };

const seqOf = (packet: RtpPacket): number => packet.header.sequenceNumber;

/** A new stream is believed once two consecutive packets of one SSRC have been seen (RFC 3550 A.1's MIN_SEQUENTIAL). */
const continues = (earlier: RtpPacket, later: RtpPacket): boolean =>
  earlier.header.ssrc === later.header.ssrc && sequenceDelta(seqOf(later), seqOf(earlier)) === 1;

class Jitter implements JitterBuffer {
  private readonly options: JitterOptions;
  private readonly queue: RtpPacket[] = [];
  /** Sequence number due next; undefined until prebuffering completes. */
  private cursor: number | undefined;
  private counters = { received: 0, played: 0, lost: 0, duplicates: 0, reordered: 0 };
  /** The last packet accepted into the current stream: the reference for "same stream". */
  private latest: RtpPacket | undefined;
  /** A packet that did not belong to the current stream, waiting for a second one to confirm a new stream. */
  private stray: RtpPacket | undefined;
  private restarts = 0;

  constructor(options: JitterOptions) {
    this.options = options;
  }

  get stats(): JitterStats {
    return { ...this.counters };
  }

  get depth(): number {
    return this.queue.length;
  }

  get resyncs(): number {
    return this.restarts;
  }

  push(packet: RtpPacket): void {
    this.counters.received += 1;
    const { stray } = this;
    if (stray !== undefined && continues(stray, packet)) {
      this.restart();
      this.admit(stray);
    } else if (this.isForeign(packet)) {
      this.stray = packet;
      return;
    } else {
      this.stray = undefined;
    }
    this.admit(packet);
  }

  private isForeign(packet: RtpPacket): boolean {
    const { latest } = this;
    if (latest === undefined) return false;
    return (
      packet.header.ssrc !== latest.header.ssrc ||
      Math.abs(sequenceDelta(seqOf(packet), seqOf(latest))) > SEQUENCE_JUMP_THRESHOLD
    );
  }

  private restart(): void {
    this.queue.length = 0;
    this.cursor = undefined;
    this.latest = undefined;
    this.stray = undefined;
    this.restarts += 1;
  }

  private admit(packet: RtpPacket): void {
    this.latest = packet;
    const index = this.slotFor(seqOf(packet));
    if (index < 0) {
      this.counters.duplicates += 1;
      return;
    }
    if (index < this.queue.length) this.counters.reordered += 1;
    this.queue.splice(index, 0, packet);
    this.trim();
  }

  pull(): RtpPacket | undefined {
    const head = this.queue[0];
    if (head === undefined || (this.cursor === undefined && !this.prebuffered())) return undefined;
    const due = this.cursor ?? seqOf(head);
    this.cursor = nextSequence(due);
    if (seqOf(head) !== due) {
      this.counters.lost += 1;
      return undefined;
    }
    this.counters.played += 1;
    return this.queue.shift();
  }

  private prebuffered(): boolean {
    return this.queue.length >= this.options.targetDepth;
  }

  /** Index to insert at, or -1 when the packet is stale or already queued. */
  private slotFor(seq: number): number {
    if (this.cursor !== undefined && sequenceDelta(seq, this.cursor) < 0) return -1;
    const at = this.queue.findIndex((queued) => sequenceDelta(seq, seqOf(queued)) <= 0);
    if (at < 0) return this.queue.length;
    return seqOf(this.queue[at] as RtpPacket) === seq ? -1 : at;
  }

  private trim(): void {
    while (this.queue.length > this.options.maxDepth) {
      this.queue.shift();
      this.skipToHead();
    }
  }

  /** Discarded frames are gone for good, so playback resumes at the oldest survivor. */
  private skipToHead(): void {
    const head = this.queue[0];
    if (this.cursor !== undefined && head !== undefined) this.cursor = seqOf(head);
  }
}

export function createJitterBuffer(options: Partial<JitterOptions> = {}): JitterBuffer {
  return new Jitter({ ...DEFAULTS, ...options });
}
