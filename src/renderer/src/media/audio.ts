/*
 * Runs inside the hidden media window. Microphone capture and speaker playback
 * live here because only a renderer has Web Audio; the RTP socket, G.711 and
 * the jitter buffer stay in the main process. Frames cross the process boundary
 * as 160 Int16 samples at 8 kHz, 50 per second per direction.
 */
import { MEDIA_FRAME_SAMPLES, MEDIA_SAMPLE_RATE } from '../../../shared/media';
import type { MediaPreloadApi } from '../../../shared/media';

/* ------------------------------------------------------------ pure signal code */

export function floatToPcm(input: Float32Array): Int16Array {
  return Int16Array.from(input, (value) => {
    const clamped = Math.max(-1, Math.min(1, value));
    return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  });
}

export function pcmToFloat(input: Int16Array): Float32Array {
  return Float32Array.from(input, (value) => value / 0x8000);
}

/** Mean of `buffer` over the fractional window [from, to), where buffer[0] is stream index `base`. */
function windowMean(buffer: Float32Array, base: number, from: number, to: number): number {
  let sum = 0;
  for (let index = Math.floor(from); index < Math.ceil(to); index += 1) {
    const overlap = Math.min(index + 1, to) - Math.max(index, from);
    sum += (buffer[index - base] as number) * overlap;
  }
  return sum / (to - from);
}

export interface Downsampler {
  push(input: Float32Array): Float32Array;
}

/**
 * Streaming box-filter decimator. Averaging every input sample under an output
 * sample is a crude low-pass that keeps aliasing out of narrow-band speech.
 * Window positions are computed from absolute counters, so the output does not
 * depend on how the input happens to be chunked.
 */
class BoxDownsampler implements Downsampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);
  private base = 0;
  private produced = 0;

  constructor(fromRate: number, toRate: number) {
    this.ratio = fromRate / toRate;
  }

  push(input: Float32Array): Float32Array {
    const buffer = new Float32Array(this.carry.length + input.length);
    buffer.set(this.carry);
    buffer.set(input, this.carry.length);
    const out: number[] = [];
    while (Math.ceil((this.produced + 1) * this.ratio) <= this.base + buffer.length) {
      out.push(windowMean(buffer, this.base, this.produced * this.ratio, (this.produced + 1) * this.ratio));
      this.produced += 1;
    }
    const keep = Math.floor(this.produced * this.ratio) - this.base;
    this.carry = buffer.slice(keep);
    this.base += keep;
    return Float32Array.from(out);
  }
}

export function createDownsampler(fromRate: number, toRate: number): Downsampler {
  return fromRate === toRate ? { push: (input) => input } : new BoxDownsampler(fromRate, toRate);
}

export interface Upsampler {
  push(frame: Int16Array): Float32Array;
}

/** Streaming linear interpolator; one input sample of latency keeps frame edges continuous. */
class LinearUpsampler implements Upsampler {
  private readonly step: number;
  private last = 0;
  private consumed = 0;
  private produced = 0;

  constructor(fromRate: number, toRate: number) {
    this.step = fromRate / toRate;
  }

  push(frame: Int16Array): Float32Array {
    const samples = pcmToFloat(frame);
    const out: number[] = [];
    const end = this.consumed + samples.length;
    let at = this.produced * this.step;
    while (at < end) {
      const index = Math.floor(at) - this.consumed;
      const before = index === 0 ? this.last : (samples[index - 1] as number);
      const after = samples[index] as number;
      out.push(before + (after - before) * (at - Math.floor(at)));
      this.produced += 1;
      at = this.produced * this.step;
    }
    this.consumed = end;
    this.last = samples[samples.length - 1] ?? this.last;
    return Float32Array.from(out);
  }
}

export function createUpsampler(fromRate: number, toRate: number): Upsampler {
  return fromRate === toRate ? { push: pcmToFloat } : new LinearUpsampler(fromRate, toRate);
}

export interface Framer {
  push(input: Float32Array): void;
}

/** Cuts a continuous float stream into exact PCM frames. */
class FrameCutter implements Framer {
  private readonly frame: Int16Array;
  private readonly emit: (frame: Int16Array) => void;
  private filled = 0;

  constructor(size: number, emit: (frame: Int16Array) => void) {
    this.frame = new Int16Array(size);
    this.emit = emit;
  }

  push(input: Float32Array): void {
    const pcm = floatToPcm(input);
    for (let offset = 0; offset < pcm.length; ) {
      const count = Math.min(this.frame.length - this.filled, pcm.length - offset);
      this.frame.set(pcm.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.frame.length) this.flush();
    }
  }

  private flush(): void {
    this.emit(this.frame.slice());
    this.filled = 0;
  }
}

export function createFramer(size: number, emit: (frame: Int16Array) => void): Framer {
  return new FrameCutter(size, emit);
}

/* ------------------------------------------------------------------ Web Audio */

/**
 * Runs on the audio thread. Capture batches 20 ms of microphone samples at the
 * context rate; playback keeps a bounded queue, waits for 40 ms before it starts
 * and rebuffers after an underrun, so a late frame costs silence rather than clicks.
 */
// i18n-exempt: AudioWorklet source code, never shown
const WORKLET_SOURCE = `
class OpenSipCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50);
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
class OpenSipPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queued = 0;
    this.primed = false;
    this.prime = Math.round(sampleRate * 0.04);
    this.limit = Math.round(sampleRate * 0.4);
    this.port.onmessage = (event) => {
      this.queue.push(event.data);
      this.queued += event.data.length;
      this.trim();
    };
  }
  trim() {
    while (this.queued > this.limit && this.queue.length > 1) {
      this.queued -= this.queue.shift().length - this.offset;
      this.offset = 0;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed && this.queued < this.prime) return true;
    this.primed = true;
    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const count = Math.min(out.length - i, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + count), i);
      i += count;
      this.offset += count;
      this.queued -= count;
      if (this.offset === head.length) { this.queue.shift(); this.offset = 0; }
    }
    if (i < out.length) this.primed = false;
    return true;
  }
}
registerProcessor('opensip-capture', OpenSipCapture);
registerProcessor('opensip-playback', OpenSipPlayback);
`;

const MICROPHONE: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    sampleRate: MEDIA_SAMPLE_RATE,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

interface Stream {
  play(samples: Int16Array): void;
  stop(): void;
}

let sharedContext: Promise<AudioContext> | undefined;

async function createContext(): Promise<AudioContext> {
  const context = new AudioContext({ sampleRate: MEDIA_SAMPLE_RATE, latencyHint: 'interactive' });
  // i18n-exempt: MIME type
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    await context.resume();
    return context;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function audioContext(): Promise<AudioContext> {
  sharedContext ??= createContext().catch((error: unknown) => {
    sharedContext = undefined;
    throw error;
  });
  return sharedContext;
}

/** The context may not honour 8 kHz, so capture is resampled from whatever rate it really runs at. */
function wireCapture(context: AudioContext, microphone: MediaStream, onFrame: (frame: Int16Array) => void): () => void {
  const node = new AudioWorkletNode(context, 'opensip-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
  const source = context.createMediaStreamSource(microphone);
  const down = createDownsampler(context.sampleRate, MEDIA_SAMPLE_RATE);
  const framer = createFramer(MEDIA_FRAME_SAMPLES, onFrame);
  node.port.onmessage = (event: MessageEvent<Float32Array>): void => framer.push(down.push(event.data));
  source.connect(node);
  return () => {
    source.disconnect();
    node.disconnect();
    node.port.close();
  };
}

function wirePlayback(context: AudioContext): Stream {
  const node = new AudioWorkletNode(context, 'opensip-playback', { numberOfInputs: 0, outputChannelCount: [1] });
  const up = createUpsampler(MEDIA_SAMPLE_RATE, context.sampleRate);
  node.connect(context.destination);
  return {
    play: (samples): void => {
      const chunk = up.push(samples);
      node.port.postMessage(chunk, [chunk.buffer]);
    },
    stop: (): void => {
      node.disconnect();
      node.port.close();
    }
  };
}

async function openStream(callId: string, api: MediaPreloadApi): Promise<Stream> {
  const context = await audioContext();
  const microphone = await navigator.mediaDevices.getUserMedia(MICROPHONE);
  try {
    const stopCapture = wireCapture(context, microphone, (frame) => api.sendCapture(callId, frame));
    const playback = wirePlayback(context);
    const stop = (): void => {
      stopCapture();
      playback.stop();
      microphone.getTracks().forEach((track) => track.stop());
    };
    return { play: playback.play, stop };
  } catch (error) {
    microphone.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

/* --------------------------------------------------------------- page wiring */

interface Slot {
  stream: Stream | undefined;
  stopped: boolean;
}

function begin(slots: Map<string, Slot>, callId: string, api: MediaPreloadApi): void {
  const slot: Slot = { stream: undefined, stopped: false };
  slots.set(callId, slot);
  openStream(callId, api).then(
    (stream) => {
      if (slot.stopped) stream.stop();
      else slot.stream = stream;
    },
    (error: unknown) => api.reportError(callId, error instanceof Error ? error.message : String(error))
  );
}

function end(slots: Map<string, Slot>, callId: string): void {
  const slot = slots.get(callId);
  slots.delete(callId);
  if (slot === undefined) return;
  slot.stopped = true;
  slot.stream?.stop();
}

export function startMediaPage(api: MediaPreloadApi): void {
  const slots = new Map<string, Slot>();
  api.onStart((callId) => begin(slots, callId, api));
  api.onStop((callId) => end(slots, callId));
  api.onPlayback((callId, samples) => slots.get(callId)?.stream?.play(samples));
}

// i18n-exempt: preload API name
if (typeof window !== 'undefined' && 'opensipMedia' in window) startMediaPage(window.opensipMedia);
