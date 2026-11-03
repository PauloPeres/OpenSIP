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
}

const DEFAULTS: JitterOptions = { targetDepth: 3, maxDepth: 10 };

const seqOf = (packet: RtpPacket): number => packet.header.sequenceNumber;

class Jitter implements JitterBuffer {
  private readonly options: JitterOptions;
  private readonly queue: RtpPacket[] = [];
  /** Sequence number due next; undefined until prebuffering completes. */
  private cursor: number | undefined;
  private counters = { received: 0, played: 0, lost: 0, duplicates: 0, reordered: 0 };

  constructor(options: JitterOptions) {
    this.options = options;
  }

  get stats(): JitterStats {
    return { ...this.counters };
  }

  get depth(): number {
    return this.queue.length;
  }

  push(packet: RtpPacket): void {
    this.counters.received += 1;
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
