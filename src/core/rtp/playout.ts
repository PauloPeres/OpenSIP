import { SAMPLES_PER_FRAME } from './g711';

/** 10 ms of G.711: the shortest packetisation in use, and the granularity we accept. */
export const PAYLOAD_GRANULE_BYTES = 80;
/** 120 ms. Anything longer is not a voice packet we can schedule without audible latency. */
export const MAX_PAYLOAD_BYTES = 960;

/**
 * A usable inbound G.711 payload is a whole number of 10 ms slices, from 10 ms
 * to 120 ms. `a=ptime` is a preference, not a contract, so 10, 30 and 40 ms
 * peers are as legitimate as 20 ms ones.
 */
export function isPlayablePayload(bytes: number): boolean {
  return bytes >= PAYLOAD_GRANULE_BYTES && bytes <= MAX_PAYLOAD_BYTES && bytes % PAYLOAD_GRANULE_BYTES === 0;
}

/** Turns packets of any length into the fixed 20 ms frames playback consumes. */
export interface FrameAssembler {
  /** True while fewer than one frame of samples is held. */
  readonly hungry: boolean;
  /** Queues decoded samples and remembers their size as the typical packet. */
  append(pcm: Int16Array): void;
  /** Queues silence the size of the last packet, standing in for one that never arrived. */
  conceal(): void;
  /** Exactly one frame; zero-padded if the queue is short. */
  take(): Int16Array;
}

class Assembler implements FrameAssembler {
  private pending = new Int16Array(0);
  private typical = SAMPLES_PER_FRAME;

  get hungry(): boolean {
    return this.pending.length < SAMPLES_PER_FRAME;
  }

  append(pcm: Int16Array): void {
    this.typical = pcm.length;
    this.queue(pcm);
  }

  conceal(): void {
    this.queue(new Int16Array(this.typical));
  }

  take(): Int16Array {
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    frame.set(this.pending.subarray(0, SAMPLES_PER_FRAME));
    this.pending = this.pending.slice(SAMPLES_PER_FRAME);
    return frame;
  }

  private queue(pcm: Int16Array): void {
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    this.pending = joined;
  }
}

export function createFrameAssembler(): FrameAssembler {
  return new Assembler();
}
