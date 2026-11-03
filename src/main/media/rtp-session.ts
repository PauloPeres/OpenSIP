import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import {
  INBOUND_TIMEOUT_MS,
  LATCH_WINDOW_MS,
  PCMA_PAYLOAD_TYPE,
  PCMU_PAYLOAD_TYPE,
  SAMPLES_PER_FRAME,
  WATCHDOG_START,
  createFrameAssembler,
  createJitterBuffer,
  isPlayablePayload,
  latchObserve,
  latchStart,
  latchTick,
  timeoutTicks,
  watchdogHeard,
  watchdogTick,
  decodeALaw,
  decodeMuLaw,
  decodeRtp,
  encodeALaw,
  encodeMuLaw,
  encodeRtp,
  nextSequence,
  nextTimestamp
} from '@core/rtp';
import type { Endpoint, LatchState, RtpPacket, WatchdogEvent, WatchdogState } from '@core/rtp';
import { DTMF_DIGITS, isDtmfDigit } from '../../shared/api';
import type { MediaStats } from '../../shared/api';

export interface RtpSessionOptions {
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  /** Negotiated voice codec: 0 (PCMU) or 8 (PCMA). */
  readonly payloadType: number;
  /** The peer's telephone-event payload type (101 by convention); absent when not offered. */
  readonly dtmfPayloadType?: number;
  readonly ssrc?: number;
  /** No inbound RTP packet for this long reports the stream as stalled. Default INBOUND_TIMEOUT_MS. */
  readonly inboundTimeoutMs?: number;
}

export interface RtpSession {
  /** Microphone PCM in; encoded, packetised and sent. */
  sendPcm(samples: Int16Array): void;
  /** Fires with decoded PCM ready for the speaker, one 20 ms frame at a time. */
  onPcm(listener: (samples: Int16Array) => void): () => void;
  /** RFC 4733 telephone-event: start, repeats, then three end packets with the E bit. */
  sendDtmf(digit: string): void;
  /** Muted still SENDS, as silence, to keep the NAT binding and the far end's stream alive. */
  setMuted(muted: boolean): void;
  /** On hold the far end may legitimately stop sending, so the inactivity watchdog pauses. */
  setHeld(held: boolean): void;
  readonly stats: MediaStats;
  readonly localPort: number;
  close(): void;
}

export interface RtpSocket {
  send(data: Uint8Array, port: number, host: string): void;
  /** `from` is the datagram's source address, which symmetric RTP needs. */
  onMessage(listener: (data: Uint8Array, from: Endpoint) => void): void;
  close(): void;
}

export interface RtpTimer {
  /** Calls `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void;
}

export interface RtpDeps {
  readonly socket: RtpSocket;
  readonly timer: RtpTimer;
  /** An unsigned 32-bit random number. */
  readonly random: () => number;
  readonly onError?: (error: unknown) => void;
  /** Things worth a line in the log: a stalled stream, an unusable packet size, a latch. */
  readonly onNotice?: (level: 'info' | 'warn', message: string) => void;
}

/* ------------------------------------------------------------------ codecs */

interface Codec {
  readonly encode: (pcm: Int16Array) => Uint8Array;
  readonly decode: (payload: Uint8Array) => Int16Array;
}

const CODECS: Readonly<Record<number, Codec>> = {
  [PCMU_PAYLOAD_TYPE]: { encode: encodeMuLaw, decode: decodeMuLaw },
  [PCMA_PAYLOAD_TYPE]: { encode: encodeALaw, decode: decodeALaw }
};

function codecFor(payloadType: number): Codec {
  const codec = Object.hasOwn(CODECS, payloadType) ? CODECS[payloadType] : undefined;
  if (codec === undefined) throw new Error('unsupported-payload-type');
  return codec;
}

const PTIME_MS = 20;
const silence = (): Int16Array => new Int16Array(SAMPLES_PER_FRAME);

/* ----------------------------------------------------------- inbound parsing */

/** Padding sits at the end; its last byte counts the padding bytes, itself included (RFC 3550 5.1). */
function withoutPadding(payload: Uint8Array): Uint8Array | undefined {
  const count = payload[payload.length - 1];
  return count === undefined || count === 0 || count > payload.length ? undefined : payload.subarray(0, payload.length - count);
}

/** The extension is a 4-byte header followed by `length` 32-bit words (RFC 3550 5.3.1). */
function withoutExtension(payload: Uint8Array): Uint8Array | undefined {
  if (payload.length < 4) return undefined;
  const end = 4 + (((payload[2] as number) << 8) | (payload[3] as number)) * 4;
  return end > payload.length ? undefined : payload.subarray(end);
}

function usablePayload(packet: RtpPacket): Uint8Array | undefined {
  const unpadded = packet.header.padding ? withoutPadding(packet.payload) : packet.payload;
  if (unpadded === undefined) return undefined;
  return packet.header.extension ? withoutExtension(unpadded) : unpadded;
}

function parseInbound(data: Uint8Array): RtpPacket | undefined {
  try {
    const packet = decodeRtp(data);
    const payload = usablePayload(packet);
    return payload === undefined ? undefined : { header: packet.header, payload };
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------- outbound stream */

/** Owns the outbound numbering: sequence, timestamp, SSRC and the talkspurt marker. */
class OutboundStream {
  sequence: number;
  timestamp: number;
  sent = 0;
  private talkspurt = true;
  private readonly ssrc: number;

  constructor(ssrc: number, sequence: number, timestamp: number) {
    this.ssrc = ssrc;
    this.sequence = sequence;
    this.timestamp = timestamp;
  }

  audio(payloadType: number, payload: Uint8Array): Uint8Array {
    const bytes = this.build(payloadType, payload, this.timestamp, this.talkspurt);
    this.talkspurt = false;
    this.timestamp = nextTimestamp(this.timestamp, SAMPLES_PER_FRAME);
    return bytes;
  }

  event(payloadType: number, payload: Uint8Array, timestamp: number, marker: boolean): Uint8Array {
    return this.build(payloadType, payload, timestamp, marker);
  }

  private build(payloadType: number, payload: Uint8Array, timestamp: number, marker: boolean): Uint8Array {
    const header = {
      version: 2 as const,
      padding: false,
      extension: false,
      csrcCount: 0,
      marker,
      payloadType,
      sequenceNumber: this.sequence,
      timestamp,
      ssrc: this.ssrc,
      csrc: []
    };
    this.sequence = nextSequence(this.sequence);
    this.sent += 1;
    return encodeRtp({ header, payload });
  }
}

/* ---------------------------------------------------------------------- DTMF */

const DTMF_VOLUME = 10;
const DTMF_END_BIT = 0x80;
/** 4 packets while the key is down, then 3 end packets: 5 x 20 ms = 100 ms of tone. */
const DTMF_TONE_PACKETS = 4;
const DTMF_END_PACKETS = 3;
const DTMF_TONE_SAMPLES = (DTMF_TONE_PACKETS + 1) * SAMPLES_PER_FRAME;

interface ActiveEvent {
  readonly code: number;
  readonly timestamp: number;
  step: number;
}

function eventPayload(code: number, step: number): Uint8Array {
  const ending = step > DTMF_TONE_PACKETS;
  const duration = Math.min(step, DTMF_TONE_PACKETS + 1) * SAMPLES_PER_FRAME;
  const flags = (ending ? DTMF_END_BIT : 0) | DTMF_VOLUME;
  return Uint8Array.of(code, flags, duration >> 8, duration & 0xff);
}

/* ------------------------------------------------------------- flow health */

type Notify = (level: 'info' | 'warn', message: string) => void;

const at = (endpoint: Endpoint): string => `${endpoint.host}:${endpoint.port}`;

/** Applies the pure watchdog and latching decisions to what the session observes. */
class FlowMonitor {
  private latch: LatchState;
  private dog: WatchdogState = WATCHDOG_START;
  private held = false;
  private readonly limit: number;
  private readonly windowTicks = timeoutTicks(LATCH_WINDOW_MS);
  private readonly notify: Notify;
  private readonly timeoutMs: number;

  constructor(advertised: Endpoint, timeoutMs: number, notify: Notify) {
    this.latch = latchStart(advertised);
    this.timeoutMs = timeoutMs;
    this.limit = timeoutTicks(timeoutMs);
    this.notify = notify;
  }

  get target(): Endpoint {
    return this.latch.target;
  }

  setHeld(held: boolean): void {
    this.held = held;
    this.dog = WATCHDOG_START;
  }

  tick(): void {
    this.latch = latchTick(this.latch, this.windowTicks);
    if (!this.held) this.report(watchdogTick(this.dog, this.limit));
  }

  /** Any RTP packet at all counts as life, whatever it carries. */
  heard(): void {
    this.report(watchdogHeard(this.dog));
  }

  /** A media packet (negotiated voice or telephone-event) from `source`. */
  observe(packet: RtpPacket, source: Endpoint): void {
    const before = this.latch.target;
    const { ssrc, sequenceNumber } = packet.header;
    this.latch = latchObserve(this.latch, { source, ssrc, sequence: sequenceNumber });
    if (this.latch.target !== before) this.notify('info', `rtp: latched media to ${at(source)}, SDP said ${at(before)}`);
  }

  private report(step: { readonly state: WatchdogState; readonly event?: WatchdogEvent }): void {
    this.dog = step.state;
    if (step.event === 'stalled') this.notify('warn', `rtp: no inbound packets for ${this.timeoutMs / 1000}s, the call may be dead`);
    if (step.event === 'resumed') this.notify('info', 'rtp: inbound packets resumed');
  }
}

/* ------------------------------------------------------------------- session */

class Session implements RtpSession {
  readonly localPort: number;
  private readonly options: RtpSessionOptions;
  private readonly deps: RtpDeps;
  private readonly codec: Codec;
  private readonly jitter = createJitterBuffer();
  private readonly listeners = new Set<(samples: Int16Array) => void>();
  private readonly stream: OutboundStream;
  private readonly queue: number[] = [];
  private readonly stopTimer: () => void;
  private readonly playout = createFrameAssembler();
  private readonly flow: FlowMonitor;
  private oddSizeReported = false;
  private active: ActiveEvent | undefined;
  private resting = false;
  private muted = false;
  private closed = false;

  constructor(options: RtpSessionOptions, deps: RtpDeps) {
    this.options = options;
    this.deps = deps;
    this.localPort = options.localPort;
    this.codec = codecFor(options.payloadType);
    const { random } = deps;
    this.stream = new OutboundStream(options.ssrc ?? random(), random() & 0xffff, random() >>> 0);
    const notify: Notify = (level, message) => deps.onNotice?.(level, message);
    const advertised = { host: options.remoteHost, port: options.remotePort };
    this.flow = new FlowMonitor(advertised, options.inboundTimeoutMs ?? INBOUND_TIMEOUT_MS, notify);
    deps.socket.onMessage((data, from) => this.onDatagram(data, from));
    this.stopTimer = deps.timer.every(PTIME_MS, () => this.onTick());
  }

  get stats(): MediaStats {
    const { received, lost } = this.jitter.stats;
    return { rxPackets: received, txPackets: this.stream.sent, lostPackets: lost, muted: this.muted };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setHeld(held: boolean): void {
    this.flow.setHeld(held);
  }

  onPcm(listener: (samples: Int16Array) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  sendPcm(samples: Int16Array): void {
    if (this.closed || this.active !== undefined || samples.length !== SAMPLES_PER_FRAME) return;
    const payload = this.codec.encode(this.muted ? silence() : samples);
    this.transmit(this.stream.audio(this.options.payloadType, payload));
  }

  sendDtmf(digit: string): void {
    const code = DTMF_DIGITS.findIndex((candidate) => candidate === digit);
    if (this.closed || this.options.dtmfPayloadType === undefined || !isDtmfDigit(digit)) return;
    this.queue.push(code);
    if (this.active === undefined && !this.resting) this.beginEvent();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.listeners.clear();
    this.queue.length = 0;
    this.active = undefined;
    this.deps.socket.close();
  }

  private transmit(data: Uint8Array): void {
    try {
      const { host, port } = this.flow.target;
      this.deps.socket.send(data, port, host);
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  private onDatagram(data: Uint8Array, from: Endpoint): void {
    if (this.closed) return;
    const packet = parseInbound(data);
    if (packet === undefined) return;
    this.flow.heard();
    const type = packet.header.payloadType;
    if (type !== this.options.payloadType && type !== this.options.dtmfPayloadType) return;
    this.flow.observe(packet, from);
    this.accept(type === this.options.payloadType ? packet : this.silentStandIn(packet));
  }

  /**
   * Telephone-event packets share the audio sequence space. Standing a silent
   * frame in for each keeps the jitter buffer from counting them as loss.
   */
  private silentStandIn(packet: RtpPacket): RtpPacket {
    const header = { ...packet.header, payloadType: this.options.payloadType };
    return { header, payload: this.codec.encode(silence()) };
  }

  private accept(packet: RtpPacket): void {
    if (isPlayablePayload(packet.payload.length)) this.jitter.push(packet);
    else this.reportOddSize(packet.payload.length);
  }

  /** Once per session: at 50 packets a second a per-packet line would flood the log. */
  private reportOddSize(bytes: number): void {
    if (this.oddSizeReported) return;
    this.oddSizeReported = true;
    this.deps.onNotice?.('warn', `rtp: dropping packets with a ${bytes}-byte payload, not a whole number of 10 ms G.711 slices`);
  }

  private onTick(): void {
    if (this.closed) return;
    this.flow.tick();
    this.stepEvent();
    this.deliver(this.nextFrame());
  }

  /** Playback wants 20 ms a tick whatever the peer's packet size; pull packets only as samples run out. */
  private nextFrame(): Int16Array {
    while (this.playout.hungry) {
      const packet = this.jitter.pull();
      if (packet === undefined) this.playout.conceal();
      else this.playout.append(this.codec.decode(packet.payload));
    }
    return this.playout.take();
  }

  private deliver(frame: Int16Array): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(frame);
      } catch (error) {
        this.deps.onError?.(error);
      }
    }
  }

  private beginEvent(): void {
    const code = this.queue.shift();
    if (code === undefined) return;
    this.active = { code, timestamp: this.stream.timestamp, step: 0 };
    this.emitEventPacket(this.active);
  }

  /** Runs on the 20 ms tick: continue the current event, or start the next queued one. */
  private stepEvent(): void {
    if (this.active !== undefined) return this.emitEventPacket(this.active);
    if (this.resting) this.resting = false;
    else this.beginEvent();
  }

  private emitEventPacket(event: ActiveEvent): void {
    event.step += 1;
    const payload = eventPayload(event.code, event.step);
    const type = this.options.dtmfPayloadType as number;
    this.transmit(this.stream.event(type, payload, event.timestamp, event.step === 1));
    if (event.step >= DTMF_TONE_PACKETS + DTMF_END_PACKETS) this.finishEvent(event);
  }

  /** Audio resumes after the tone, so its timestamp must account for the time the event took. */
  private finishEvent(event: ActiveEvent): void {
    this.stream.timestamp = nextTimestamp(event.timestamp, DTMF_TONE_SAMPLES);
    this.active = undefined;
    this.resting = true;
  }
}

/* ----------------------------------------------------------------- real I/O */

const bytesOf = (message: Buffer): Uint8Array => new Uint8Array(message.buffer, message.byteOffset, message.length);

function createUdpSocket(localPort: number, onError: RtpDeps['onError']): RtpSocket {
  const socket = createSocket('udp4');
  socket.on('error', (error) => onError?.(error));
  socket.bind(localPort);
  return {
    send: (data, port, host) =>
      socket.send(data, port, host, (error) => {
        if (error !== null) onError?.(error);
      }),
    onMessage: (listener) =>
      void socket.on('message', (message, from) => listener(bytesOf(message), { host: from.address, port: from.port })),
    close: (): void => {
      try {
        socket.close();
      } catch (error) {
        onError?.(error);
      }
    }
  };
}

const intervalTimer: RtpTimer = {
  every: (ms, tick) => {
    const handle = setInterval(tick, ms);
    handle.unref();
    return () => clearInterval(handle);
  }
};

const randomUint32 = (): number => randomInt(0, 2 ** 32);

export function createRtpSession(options: RtpSessionOptions, deps: Partial<RtpDeps> = {}): RtpSession {
  const { onError, onNotice } = deps;
  const complete: RtpDeps = {
    socket: deps.socket ?? createUdpSocket(options.localPort, onError),
    timer: deps.timer ?? intervalTimer,
    random: deps.random ?? randomUint32,
    ...(onError === undefined ? {} : { onError }),
    ...(onNotice === undefined ? {} : { onNotice })
  };
  return new Session(options, complete);
}

/* ------------------------------------------------------------ port allocation */

export interface PortDeps {
  /** True when this UDP port can be bound. */
  readonly isFree: (port: number) => Promise<boolean>;
  readonly random: () => number;
}

const FIRST_PORT = 16_384;
const LAST_PORT = 32_766;
const ALLOCATION_ATTEMPTS = 25;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => {
      socket.close();
      resolve(false);
    });
    socket.bind(port, () => socket.close(() => resolve(true)));
  });
}

/** An RTP port and its RTCP neighbour (port + 1) must both be available. */
const pairIsFree = async (port: number): Promise<boolean> => (await canBind(port)) && (await canBind(port + 1));

const defaultPortDeps: PortDeps = { isFree: pairIsFree, random: Math.random };

/** An EVEN port in 16384..32767; RTCP implicitly uses port + 1. */
export async function allocateRtpPort(deps: Partial<PortDeps> = {}): Promise<number> {
  const { isFree, random } = { ...defaultPortDeps, ...deps };
  const slots = (LAST_PORT - FIRST_PORT) / 2 + 1;
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
    const port = FIRST_PORT + 2 * Math.floor(random() * slots);
    if (await isFree(port)) return port;
  }
  throw new Error('no-free-rtp-port');
}
