import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsLog } from '../../src/core/diagnostics';
import { createAccount, headerValue } from '../../src/core/sip';
import type { SipMessage, SipRequest, SipResponse, TransportCandidate } from '../../src/core/sip';
import type { MediaBridge } from '../../src/main/media/media-window';
import type { RtpSession, RtpSessionOptions } from '../../src/main/media/rtp-session';
import { openConnection } from '../../src/main/sip/connection';
import { buildRegisterRequest } from '../../src/main/sip/registrar';
import type { SipConnection } from '../../src/main/sip/connection';
import { CALL_SETUP_TIMEOUT_MS, CALL_WAITING_GRACE_MS, ENDED_CALL_LINGER_MS, SipEngine } from '../../src/main/sip/engine';
import { createMediaBridge } from '../../src/main/media/media-window';
import type { MediaBridgeDeps, MediaWindowHandle } from '../../src/main/media/media-window';
import { MEDIA_FRAME_SAMPLES, MEDIA_IPC, toPcmFrame } from '../../src/shared/media';
import {
  createDownsampler,
  createFramer,
  createUpsampler,
  floatToPcm,
  pcmToFloat
} from '../../src/renderer/src/media/audio';

vi.mock('../../src/main/windows', () => ({ log: (): void => undefined }));

const udp = vi.hoisted(() => ({ sockets: [] as unknown[], lan: '192.168.1.50' }));

/** A dgram socket fake that, like the kernel, drops foreign sources once `connect` has been called. */
vi.mock('node:dgram', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeDgram extends Emitter {
    connected = false;
    bound = false;
    sent: { text: string; port: number | undefined; host: string | undefined }[] = [];
    connect(_port: number, _host: string, done: () => void): void {
      this.connected = true;
      queueMicrotask(done);
    }
    bind(_port: number, done?: () => void): void {
      this.bound = true;
      if (done !== undefined) queueMicrotask(done);
      queueMicrotask(() => this.emit('listening'));
    }
    address(): { address: string; port: number; family: string } {
      return { address: this.connected ? udp.lan : '0.0.0.0', port: 40123, family: 'IPv4' };
    }
    send(text: string, ...rest: unknown[]): void {
      const done = rest.find((item) => typeof item === 'function') as ((error?: Error) => void) | undefined;
      const [port, host] = rest.filter((item) => typeof item !== 'function') as [number?, string?];
      this.sent.push({ text, port, host });
      done?.();
    }
    receive(data: string, from: { address: string; port: number }, server: { host: string; port: number }): void {
      const matches = from.address === server.host && from.port === server.port;
      if (this.connected && !matches) return;
      this.emit('message', Buffer.from(data), from);
    }
    close(): void {
      this.emit('close');
    }
  }
  return { createSocket: (): FakeDgram => { const socket = new FakeDgram(); udp.sockets.push(socket); return socket; } };
});

type Handler = (sender: unknown, ...args: unknown[]) => void;

interface Message {
  readonly channel: string;
  readonly args: readonly unknown[];
}

class FakeWindow implements MediaWindowHandle {
  readonly sent: Message[] = [];
  destroyed = false;
  readonly ready: Promise<void>;
  readonly settle: { resolve: () => void; reject: (error: Error) => void };
  private closers: (() => void)[] = [];

  constructor() {
    let resolve = (): void => undefined;
    let reject: (error: Error) => void = () => undefined;
    this.ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.ready.catch(() => undefined);
    this.settle = { resolve, reject };
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.sent.push({ channel, args });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  owns(sender: unknown): boolean {
    return sender === this;
  }
  onClosed(listener: () => void): void {
    this.closers.push(listener);
  }
  destroy(): void {
    this.destroyed = true;
  }
  close(): void {
    this.destroyed = true;
    this.closers.forEach((listener) => listener());
  }
  channels(): string[] {
    return this.sent.map((m) => m.channel);
  }
}

function setup(): {
  windows: FakeWindow[];
  deps: MediaBridgeDeps;
  emit: (sender: unknown, ...args: unknown[]) => void;
  emitOn: (channel: string, sender: unknown, ...args: unknown[]) => void;
  logs: string[];
  unlisten: ReturnType<typeof vi.fn>;
  listening: () => boolean;
} {
  const windows: FakeWindow[] = [];
  const logs: string[] = [];
  const handlers = new Map<string, Handler>();
  const unlisten = vi.fn();
  const deps: MediaBridgeDeps = {
    createWindow: () => {
      const window = new FakeWindow();
      windows.push(window);
      return window;
    },
    listen: (channel, handler) => {
      handlers.set(channel, handler);
      return () => {
        handlers.delete(channel);
        unlisten();
      };
    },
    log: (message) => void logs.push(message)
  };
  return {
    windows,
    deps,
    logs,
    unlisten,
    listening: () => handlers.has(MEDIA_IPC.capture),
    emit: (sender, ...args) => handlers.get(MEDIA_IPC.capture)?.(sender, ...args),
    emitOn: (channel, sender, ...args) => handlers.get(channel)?.(sender, ...args)
  };
}

const frame = (value = 7): Int16Array => new Int16Array(MEDIA_FRAME_SAMPLES).fill(value);
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function readyBridge(): Promise<ReturnType<typeof setup> & { bridge: ReturnType<typeof createMediaBridge>; window: FakeWindow }> {
  const env = setup();
  const bridge = createMediaBridge(env.deps);
  bridge.start('c1');
  const window = env.windows[0] as FakeWindow;
  window.settle.resolve();
  await flush();
  return { ...env, bridge, window };
}

describe('toPcmFrame', () => {
  it('accepts a 160-sample Int16Array', () => {
    const input = frame(3);
    expect(toPcmFrame(input)).toEqual(input);
  });

  it('accepts 320 raw bytes as an ArrayBuffer or a Uint8Array view, even when unaligned', () => {
    const source = Int16Array.from({ length: MEDIA_FRAME_SAMPLES }, (_, i) => i - 80);
    const bytes = new Uint8Array(source.buffer);
    expect(toPcmFrame(source.buffer)).toEqual(source);
    expect(toPcmFrame(bytes)).toEqual(source);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    expect(toPcmFrame(shifted.subarray(1))).toEqual(source);
  });

  it('copies, so a later change to the transferred buffer cannot alter the frame', () => {
    const input = frame(1);
    const out = toPcmFrame(input) as Int16Array;
    input[0] = 99;
    expect(out[0]).toBe(1);
  });

  it('rejects anything that is not exactly one 20 ms frame of binary PCM', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'abc',
      42,
      {},
      Array.from({ length: MEDIA_FRAME_SAMPLES }, () => 0),
      new Int16Array(159),
      new Int16Array(161),
      new Uint8Array(319),
      new Float32Array(MEDIA_FRAME_SAMPLES),
      new ArrayBuffer(10)
    ];
    for (const value of bad) expect(toPcmFrame(value)).toBeUndefined();
  });
});

describe('media window lifecycle', () => {
  it('creates nothing until a stream is started, and only one window for several streams', () => {
    const { deps, windows } = setup();
    const bridge = createMediaBridge(deps);
    expect(windows).toHaveLength(0);
    bridge.start('a');
    bridge.start('b');
    expect(windows).toHaveLength(1);
  });

  it('queues start requests until the page has loaded, then delivers them in order', async () => {
    const { deps, windows } = setup();
    const bridge = createMediaBridge(deps);
    bridge.start('a');
    bridge.stop('a');
    bridge.start('b');
    const window = windows[0] as FakeWindow;
    expect(window.sent).toHaveLength(0);
    window.settle.resolve();
    await flush();
    expect(window.sent).toEqual([
      { channel: MEDIA_IPC.start, args: ['a'] },
      { channel: MEDIA_IPC.stop, args: ['a'] },
      { channel: MEDIA_IPC.start, args: ['b'] }
    ]);
  });

  it('drops playback frames while the page is still loading instead of queueing them', async () => {
    const { deps, windows } = setup();
    const bridge = createMediaBridge(deps);
    bridge.start('a');
    bridge.play('a', frame());
    const window = windows[0] as FakeWindow;
    window.settle.resolve();
    await flush();
    expect(window.channels()).toEqual([MEDIA_IPC.start]);
  });

  it('survives the page being slow to load: many frames, no crash, no growth', async () => {
    const { deps, windows } = setup();
    const bridge = createMediaBridge(deps);
    bridge.start('a');
    for (let i = 0; i < 5000; i += 1) bridge.play('a', frame());
    (windows[0] as FakeWindow).settle.resolve();
    await flush();
    expect((windows[0] as FakeWindow).sent).toHaveLength(1);
  });

  it('recreates the window when it has been destroyed and restarts the live streams', async () => {
    const { bridge, windows, window } = await readyBridge();
    window.close();
    bridge.play('c1', frame());
    expect(windows).toHaveLength(2);
    const next = windows[1] as FakeWindow;
    next.settle.resolve();
    await flush();
    expect(next.sent).toEqual([{ channel: MEDIA_IPC.start, args: ['c1'] }]);
  });

  it('notices a destroyed window even if no close event was delivered', async () => {
    const { bridge, windows, window } = await readyBridge();
    window.destroyed = true;
    bridge.start('c2');
    expect(windows).toHaveLength(2);
    (windows[1] as FakeWindow).settle.resolve();
    await flush();
    expect((windows[1] as FakeWindow).sent.map((m) => m.args[0]).sort()).toEqual(['c1', 'c2']);
  });

  it('does not restart a stream that was stopped before the window was recreated', async () => {
    const { bridge, windows, window } = await readyBridge();
    bridge.stop('c1');
    window.close();
    bridge.start('c2');
    (windows[1] as FakeWindow).settle.resolve();
    await flush();
    expect((windows[1] as FakeWindow).sent.map((m) => m.args[0])).toEqual(['c2']);
  });

  it('logs a page that fails to load and recovers on the next request', async () => {
    const { deps, windows, logs } = setup();
    const bridge = createMediaBridge(deps);
    bridge.start('a');
    (windows[0] as FakeWindow).settle.reject(new Error('ERR_FILE_NOT_FOUND'));
    await flush();
    expect(logs.join('\n')).toContain('ERR_FILE_NOT_FOUND');
    expect(() => bridge.play('a', frame())).not.toThrow();
    expect(windows.length).toBeGreaterThanOrEqual(2);
  });

  it('never throws when the window dies between the check and the send', async () => {
    const { bridge, window } = await readyBridge();
    vi.spyOn(window, 'send').mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    expect(() => bridge.play('c1', frame())).not.toThrow();
  });

  it('logs problems the media window reports, but only from the media window', async () => {
    const { logs, window, emitOn } = await readyBridge();
    emitOn(MEDIA_IPC.error, window, 'c1', 'NotAllowedError');
    emitOn(MEDIA_IPC.error, {}, 'c1', 'spoofed');
    expect(logs.join('\n')).toContain('NotAllowedError');
    expect(logs.join('\n')).not.toContain('spoofed');
  });

  it('dispose() destroys the window and stops listening', async () => {
    const { bridge, window, unlisten, listening } = await readyBridge();
    bridge.dispose();
    expect(window.destroyed).toBe(true);
    expect(unlisten).toHaveBeenCalled();
    expect(listening()).toBe(false);
  });
});

describe('playback', () => {
  it('sends a 160-sample Int16Array to the window, tagged with the call', async () => {
    const { bridge, window } = await readyBridge();
    bridge.play('c1', frame(5));
    const message = window.sent[window.sent.length - 1] as Message;
    expect(message.channel).toBe(MEDIA_IPC.playback);
    expect(message.args[0]).toBe('c1');
    expect(message.args[1]).toBeInstanceOf(Int16Array);
    expect(message.args[1]).toEqual(frame(5));
  });

  it('does not send anything for a call that is not streaming, or a frame of the wrong size', async () => {
    const { bridge, window } = await readyBridge();
    const before = window.sent.length;
    bridge.play('other', frame());
    bridge.play('c1', new Int16Array(10));
    bridge.stop('c1');
    bridge.play('c1', frame());
    expect(window.sent.slice(before).map((m) => m.channel)).toEqual([MEDIA_IPC.stop]);
  });
});

describe('capture', () => {
  it('delivers microphone frames from the media window to listeners', async () => {
    const { bridge, window, emit } = await readyBridge();
    const seen: [string, Int16Array][] = [];
    bridge.onCapture((callId, samples) => void seen.push([callId, samples]));
    emit(window, 'c1', frame(9));
    expect(seen).toEqual([['c1', frame(9)]]);
  });

  it('accepts raw bytes as well as a typed array', async () => {
    const { bridge, window, emit } = await readyBridge();
    const listener = vi.fn();
    bridge.onCapture(listener);
    emit(window, 'c1', new Uint8Array(frame(2).buffer));
    expect(listener).toHaveBeenCalledWith('c1', frame(2));
  });

  it('ignores frames sent by any other web contents', async () => {
    const { bridge, emit } = await readyBridge();
    const listener = vi.fn();
    bridge.onCapture(listener);
    emit({ not: 'the media window' }, 'c1', frame());
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores malformed frames, non-string call ids and calls that are not streaming', async () => {
    const { bridge, window, emit } = await readyBridge();
    const listener = vi.fn();
    bridge.onCapture(listener);
    emit(window, 'c1', new Int16Array(3));
    emit(window, 'c1', [1, 2, 3]);
    emit(window, 'c1', 'x');
    emit(window, 42, frame());
    emit(window, 'unknown', frame());
    emit(window, 'c1');
    bridge.stop('c1');
    emit(window, 'c1', frame());
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying a listener that unsubscribed, and isolates a throwing listener', async () => {
    const { bridge, window, emit } = await readyBridge();
    const quiet = vi.fn();
    const off = bridge.onCapture(quiet);
    bridge.onCapture(() => {
      throw new Error('listener bug');
    });
    const after = vi.fn();
    bridge.onCapture(after);
    off();
    expect(() => emit(window, 'c1', frame())).not.toThrow();
    expect(quiet).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('audio helpers used by the hidden window', () => {
  const constant = (length: number, value: number): Float32Array => new Float32Array(length).fill(value);
  const concat = (parts: Float32Array[]): Float32Array => Float32Array.from(parts.flatMap((p) => [...p]));

  it('converts float samples to clamped 16-bit PCM and back', () => {
    expect([...floatToPcm(Float32Array.of(0, 1, -1, 2, -2, 0.5))]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    expect(pcmToFloat(Int16Array.of(0, 16384, -32768))[2]).toBe(-1);
    expect(pcmToFloat(Int16Array.of(16384))[0]).toBeCloseTo(0.5, 3);
  });

  it('does not touch audio that is already 8 kHz', () => {
    const down = createDownsampler(8000, 8000);
    const input = Float32Array.of(0.1, -0.2, 0.3);
    expect(down.push(input)).toEqual(input);
  });

  it('downsamples 48 kHz to 8 kHz at one sample in six, preserving level', () => {
    const out = createDownsampler(48_000, 8000).push(constant(960, 0.5));
    expect(out).toHaveLength(160);
    expect([...out].every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('averages neighbouring samples so a signal at the output Nyquist rate is attenuated', () => {
    const alternating = Float32Array.from({ length: 960 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const out = createDownsampler(48_000, 8000).push(alternating);
    expect([...out].every((v) => Math.abs(v) < 1e-6)).toBe(true);
  });

  it('produces the same output however the input is chunked, including non-integer ratios', () => {
    const input = Float32Array.from({ length: 4400 }, (_, i) => Math.sin(i / 7));
    const whole = createDownsampler(44_100, 8000).push(input);
    const chunked = createDownsampler(44_100, 8000);
    const parts: Float32Array[] = [];
    for (let at = 0; at < input.length; at += 128) parts.push(chunked.push(input.subarray(at, at + 128)));
    const joined = concat(parts);
    expect(joined).toHaveLength(whole.length);
    expect(Math.abs(whole.length - 798)).toBeLessThanOrEqual(1);
    whole.forEach((v, i) => expect(joined[i]).toBeCloseTo(v, 5));
  });

  it('cuts exact 160-sample frames out of an arbitrary stream', () => {
    const frames: Int16Array[] = [];
    const framer = createFramer(MEDIA_FRAME_SAMPLES, (f) => void frames.push(f));
    framer.push(constant(100, 0.5));
    expect(frames).toHaveLength(0);
    framer.push(constant(100, 0.5));
    expect(frames).toHaveLength(1);
    framer.push(constant(500, 0.5));
    expect(frames).toHaveLength(4);
    expect(frames.every((f) => f.length === MEDIA_FRAME_SAMPLES && f[0] === 16384)).toBe(true);
  });

  it('upsamples 8 kHz frames to the context rate with linear interpolation', () => {
    const up = createUpsampler(8000, 48_000);
    const out = up.push(Int16Array.from({ length: MEDIA_FRAME_SAMPLES }, (_, i) => (i % 2 === 0 ? 0 : 16384)));
    expect(out).toHaveLength(960);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[9]).toBeCloseTo(0.25, 2);
    expect(out[12]).toBeCloseTo(0.5, 2);
  });

  it('keeps playback continuous across frame boundaries, whatever the ratio', () => {
    const a = Int16Array.from({ length: MEDIA_FRAME_SAMPLES }, (_, i) => i * 100);
    const b = Int16Array.from({ length: MEDIA_FRAME_SAMPLES }, (_, i) => (i + 160) * 100);
    const split = createUpsampler(8000, 44_100);
    const together = createUpsampler(8000, 44_100);
    const joined = concat([split.push(a), split.push(b)]);
    const whole = together.push(Int16Array.from([...a, ...b]));
    expect(joined).toHaveLength(whole.length);
    whole.forEach((v, i) => expect(joined[i]).toBeCloseTo(v, 5));
  });

  it('passes 8 kHz playback straight through', () => {
    const out = createUpsampler(8000, 8000).push(frame(16384));
    expect(out).toHaveLength(MEDIA_FRAME_SAMPLES);
    expect(out[0]).toBeCloseTo(0.5, 3);
  });
});

/* ------------------------------------------------------------------------
 * The engine against a scripted PBX: the only mechanical proof that the
 * signalling, the RTP session and the media bridge are wired together.
 * ---------------------------------------------------------------------- */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

type FakeSession = {
  sendPcm: ReturnType<typeof vi.fn>;
  onPcm: ReturnType<typeof vi.fn>;
  sendDtmf: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  localPort: number;
  stats: { rxPackets: number; txPackets: number; lostPackets: number; muted: boolean };
};
type Harness = {
  pbx: Pbx;
  engine: SipEngine;
  created: { options: RtpSessionOptions; session: FakeSession }[];
  media: MediaBridge & Record<string, ReturnType<typeof vi.fn>>;
  diagnostics: ReturnType<typeof createDiagnosticsLog>;
  clock: { now: number };
};

class Pbx {
  readonly sent: SipMessage[] = [];
  private readonly handlers: ((m: SipMessage) => void)[] = [];
  respond: (m: SipRequest) => SipResponse[] = () => [];
  readonly connection: SipConnection;

  constructor() {
    this.connection = {
      candidate: { transport: 'udp', host: 'pbx.test', port: 5060, source: 'manual' } as never,
      localAddress: { host: '10.0.0.5', port: 5060 },
      send: async (m) => {
        this.sent.push(m);
        if (m.kind === 'request') for (const r of this.respond(m)) queueMicrotask(() => this.inject(r));
      },
      onMessage: (l) => { this.handlers.push(l); return () => undefined; },
      onClose: () => () => undefined,
      close: () => undefined
    } as SipConnection;
  }
  inject(m: SipMessage): void { this.handlers.forEach((h) => h(m)); }
  requests(method: string): SipRequest[] { return this.sent.filter((m): m is SipRequest => m.kind === 'request' && m.method === method); }
}

function reply(req: SipRequest, status: number, extra: Record<string, string[]> = {}, body = ''): SipResponse {
  const h = req.headers;
  const to = headerValue(h, 'to') ?? '';
  return {
    kind: 'response', status, reason: 'X', body,
    headers: {
      via: [`${(h['via'] ?? [''])[0]};received=198.51.100.7;rport=5099`],
      from: h['from'] ?? [], to: [status >= 200 && !/tag=/.test(to) ? `${to};tag=pbx1` : to],
      'call-id': h['call-id'] ?? [], cseq: h['cseq'] ?? [], contact: ['<sip:1001@203.0.113.9:5060>'],
      'record-route': ['<sip:rr1.test;lr>', '<sip:rr2.test;lr>'],
      ...extra
    }
  };
}

const ANSWER = ['v=0', 'o=- 1 1 IN IP4 203.0.113.9', 's=-', 'c=IN IP4 203.0.113.9', 't=0 0', 'm=audio 40000 RTP/AVP 8 101', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n');

function harness(): Harness {
  const pbx = new Pbx();
  const created: { options: RtpSessionOptions; session: ReturnType<typeof fakeSession> }[] = [];
  const media = { start: vi.fn(), stop: vi.fn(), play: vi.fn(), onCapture: vi.fn(() => () => undefined), dispose: vi.fn() } as unknown as MediaBridge & Record<string, ReturnType<typeof vi.fn>>;
  const diagnostics = createDiagnosticsLog({ debug: true });
  const clock = { now: 1_000_000 };
  const engine = new SipEngine({
    probe: { resolveSrv: async () => { throw new Error('nx'); }, probe: async () => 5, now: () => 0 },
    open: async () => pbx.connection,
    diagnostics, media, now: () => clock.now,
    rtp: { allocatePort: async () => 20000, create: (options) => { const session = fakeSession(); created.push({ options, session }); return session as unknown as RtpSession; } }
  });
  return { pbx, engine, created, media, diagnostics, clock };
}
function fakeSession(): FakeSession {
  return { sendPcm: vi.fn(), onPcm: vi.fn(() => () => undefined), sendDtmf: vi.fn(), setMuted: vi.fn(), close: vi.fn(), localPort: 20000, stats: { rxPackets: 3, txPackets: 4, lostPackets: 1, muted: false } };
}

async function registered(h: Harness): Promise<void> {
  h.pbx.respond = (m) => (m.method === 'REGISTER' ? [reply(m, 200, { expires: ['300'] })] : []);
  const account = createAccount({ displayName: 'Me', username: '1000', password: 'secret', domain: 'pbx.test' }, 'acc1');
  await h.engine.startAccount(account);
  await settle(); await settle();
  expect(h.engine.getRegistrations()['acc1']?.state).toBe('registered');
}

describe('engine outbound call', () => {
  it('registers, logs, dials with digest, connects media, DTMF, hold, hangup', async () => {
    const h = harness();
    await registered(h);
    const keys = h.diagnostics.entries().map((e) => e.messageKey);
    expect(keys).toEqual(expect.arrayContaining(['logs.event.probe', 'logs.event.transport', 'logs.event.registering', 'logs.event.nat', 'logs.event.registered', 'logs.event.sent', 'logs.event.received']));
    expect(h.diagnostics.entries().some((e) => e.raw?.includes('secret'))).toBe(false);

    let invites = 0;
    h.pbx.respond = (m) => {
      if (m.method !== 'INVITE') return [];
      invites += 1;
      if (invites === 1) return [reply(m, 401, { 'www-authenticate': ['Digest realm="pbx", nonce="abc", algorithm=MD5, qop="auth"'] })];
      return [reply(m, 180), reply(m, 200, {}, ANSWER)];
    };
    expect((await h.engine.dial('acc1', '1001'))).toMatchObject({ ok: true });
    await settle();
    const ins = h.pbx.requests('INVITE');
    expect(ins).toHaveLength(2);
    expect(headerValue((ins[1] as SipRequest).headers, 'authorization')).toMatch(/^Digest /);
    expect(headerValue((ins[1] as SipRequest).headers, 'cseq')).toBe('2 INVITE');
    const acks = h.pbx.requests('ACK');
    expect(acks).toHaveLength(2);
    expect(headerValue((acks[0] as SipRequest).headers, 'cseq')).toBe('1 ACK');
    expect(headerValue((acks[1] as SipRequest).headers, 'cseq')).toBe('2 ACK');
    const [view] = h.engine.getCallViews();
    expect(view?.call.state).toBe('active');
    expect(view?.connectedAt).toBeTypeOf('number');
    expect(view?.media).toEqual({ rxPackets: 3, txPackets: 4, lostPackets: 1, muted: false });
    expect(h.created[0]?.options).toEqual({ localPort: 20000, remoteHost: '203.0.113.9', remotePort: 40000, payloadType: 8, dtmfPayloadType: 101 });
    expect(h.media.start).toHaveBeenCalledWith(view?.call.id);

    const id = view?.call.id as string;
    h.engine.sendDtmf(id, '5');
    expect(h.created[0]?.session.sendDtmf).toHaveBeenCalledWith('5');
    h.engine.setMuted(id, true);
    expect(h.created[0]?.session.setMuted).toHaveBeenLastCalledWith(true);
    expect(h.engine.getCallViews()[0]?.media?.muted).toBe(true);

    await h.engine.hold(id);
    expect(h.created[0]?.session.setMuted).toHaveBeenLastCalledWith(true);
    const hold = h.pbx.requests('INVITE')[2] as SipRequest;
    expect(hold.body).toContain('a=sendonly');
    expect(hold.body).toContain('RTP/AVP 8 101');
    expect(hold.uri).toBe('sip:1001@203.0.113.9:5060');
    expect((hold.headers['route'] ?? []).join(',')).toBe('<sip:rr2.test;lr>,<sip:rr1.test;lr>');
    await h.engine.resume(id);
    expect((h.pbx.requests('INVITE')[3] as SipRequest).body).toContain('a=sendrecv');

    await h.engine.hangup(id);
    expect(h.pbx.requests('BYE')).toHaveLength(1);
    expect(h.created[0]?.session.close).toHaveBeenCalled();
    expect(h.media.stop).toHaveBeenCalledWith(id);
    expect(h.engine.getCallViews()).toHaveLength(0);
  });

  const progressKeys = (h: Harness): string[] =>
    h.diagnostics.entries().map((e) => e.messageKey).filter((key) => key.startsWith('calls.progress.'));

  it('reports trying, ringing, connecting and active for a call that rings then answers', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 180), reply(m, 183), reply(m, 200, {}, ANSWER)] : []);
    await h.engine.dial('acc1', '1001');
    await settle();
    expect(progressKeys(h)).toEqual([
      'calls.progress.trying',
      'calls.progress.ringing',
      'calls.progress.connecting',
      'calls.progress.active'
    ]);
    const [view] = h.engine.getCallViews();
    expect(view?.progress).toBe('calls.progress.active');
    expect(view?.endReasonKey).toBeUndefined();
    const logged = h.diagnostics.entries().find((e) => e.messageKey === 'calls.progress.ringing');
    expect(logged?.level).toBe('info');
  });

  it('shows ringing on the view while the call is still ringing', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 180)] : []);
    await h.engine.dial('acc1', '1001');
    await settle();
    expect(h.engine.getCallViews()[0]?.progress).toBe('calls.progress.ringing');
  });

  it('maps a 486 to a busy end reason, ACKs it, and ends the call', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 486)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    expect(h.pbx.requests('ACK')).toHaveLength(1);
    const [view] = h.engine.getCallViews();
    expect(view?.call.state).toBe('ended');
    expect(view?.endReasonKey).toBe('calls.endReason.busy');
    expect(view?.progress).toBe('calls.progress.ended');
    expect(h.diagnostics.entries().some((e) => e.messageKey === 'calls.error.failed')).toBe(true);
    expect(h.diagnostics.entries().some((e) => e.messageKey === 'calls.endReason.busy' && e.level === 'info')).toBe(true);
    expect(h.created).toHaveLength(0);
  });

  it('lets an ended call lapse after ENDED_CALL_LINGER_MS on the injected clock, or at the next dial', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 486)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    const start = h.clock.now;
    expect(h.engine.getCallViews()).toHaveLength(1);
    h.clock.now = start + ENDED_CALL_LINGER_MS - 1;
    expect(h.engine.getCallViews()).toHaveLength(1);
    h.clock.now = start + ENDED_CALL_LINGER_MS;
    expect(h.engine.getCallViews()).toHaveLength(0);
  });

  it('clears an ended call at the next dial of the same account only', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 486)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    const ended = h.engine.getCallViews()[0]?.call.id;
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 180)] : []);
    await h.engine.dial('acc1', '1003');
    expect(h.engine.getCallViews().some((v) => v.call.id === ended)).toBe(false);
  });

  it('notifies listeners once when the linger window closes while the row is still shown', async () => {
    const h = harness();
    await registered(h);
    vi.useFakeTimers();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 603)] : []);
      await h.engine.dial('acc1', '1002');
      await vi.advanceTimersByTimeAsync(10);
      const changes = vi.fn();
      h.engine.onChange(changes);
      await vi.advanceTimersByTimeAsync(ENDED_CALL_LINGER_MS);
      expect(changes).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [603, 'calls.endReason.declined'],
    [600, 'calls.endReason.busy'],
    [480, 'calls.endReason.unanswered'],
    [408, 'calls.endReason.unanswered'],
    [404, 'calls.endReason.unreachable'],
    [484, 'calls.endReason.unreachable'],
    [604, 'calls.endReason.unreachable']
  ])('maps a %i rejection to %s', async (status, key) => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 180), reply(m, status)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    expect(h.engine.getCallViews()[0]?.endReasonKey).toBe(key);
  });

  it('leaves no end reason for a failure the user need not explain, and clears a shown one on the next dial', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 500)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    expect(h.engine.getCallViews()).toHaveLength(0);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 603)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    expect(h.engine.getCallViews()).toHaveLength(1);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 180)] : []);
    await h.engine.dial('acc1', '1003');
    expect(h.engine.getCallViews().map((v) => v.endReasonKey)).toEqual([undefined]);
  });

  it('acknowledges a retransmitted 200 again, and hangs up on a 200 that carries no usable SDP', async () => {
    const h = harness();
    await registered(h);
    let answer: SipResponse | undefined;
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [(answer = reply(m, 200, {}, ANSWER))] : []);
    await h.engine.dial('acc1', '1001');
    await settle();
    h.pbx.inject(answer as SipResponse);
    expect(h.pbx.requests('ACK')).toHaveLength(2);

    const bad = harness();
    await registered(bad);
    bad.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 200)] : []);
    await bad.engine.dial('acc1', '1001');
    await settle();
    expect(bad.pbx.requests('ACK')).toHaveLength(1);
    expect(bad.pbx.requests('BYE')).toHaveLength(1);
    expect(bad.engine.getCallViews()).toHaveLength(0);
    expect(bad.created).toHaveLength(0);
  });

  it('cancels an unanswered call', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 180)] : m.method === 'CANCEL' ? [reply(m, 200)] : []);
    const result = await h.engine.dial('acc1', '1003');
    await settle();
    const id = (result as { callId: string }).callId;
    await h.engine.hangup(id);
    const cancel = h.pbx.requests('CANCEL')[0] as SipRequest;
    expect(headerValue(cancel.headers, 'cseq')).toBe('1 CANCEL');
    expect(headerValue(cancel.headers, 'via')).toBe(headerValue((h.pbx.requests('INVITE')[0] as SipRequest).headers, 'via'));
    expect(h.engine.getCallViews()).toHaveLength(0);
    expect(h.pbx.requests('BYE')).toHaveLength(0);
  });

  it('refuses when unregistered / invalid / over limit', async () => {
    const h = harness();
    expect(await h.engine.dial('nope', '1')).toEqual({ ok: false, errorKey: 'calls.error.notRegistered' });
    await registered(h);
    expect(await h.engine.dial('acc1', '   ')).toEqual({ ok: false, errorKey: 'calls.error.invalidTarget' });
    h.pbx.respond = () => [];
    for (let i = 0; i < 4; i += 1) await h.engine.dial('acc1', `10${i}`);
    expect(await h.engine.dial('acc1', '999')).toEqual({ ok: false, errorKey: 'calls.error.limitReached' });
    await h.engine.stop();
  });
});

/* ------------------------------------------------------------------------
 * RFC 3261 17.1.1 cancels timer B at the first provisional response, so a UAC
 * that has seen a 100 would wait forever. The engine adds its own guard.
 * ---------------------------------------------------------------------- */

describe('engine call-setup guard', () => {
  const SECOND = 1000;
  const WAITING = 'calls.progress.waiting';
  const TRYING = 'calls.progress.trying';
  const SILENT = 'calls.endReason.setupTimeout';

  const fakeClockHarness = async (): Promise<Harness> => {
    const h = harness();
    await registered(h);
    vi.useFakeTimers();
    return h;
  };
  const invite = (h: Harness, index = 0): SipRequest => h.pbx.requests('INVITE')[index] as SipRequest;
  const view = (h: Harness): ReturnType<SipEngine['getCallViews']>[number] | undefined => h.engine.getCallViews()[0];
  const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('exports a 90 second setup limit', () => {
    expect(CALL_SETUP_TIMEOUT_MS).toBe(90_000);
  });

  it('keeps a call that only ever got a 100 alive at 89 999 ms and cancels it at exactly 90 000 ms', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(CALL_SETUP_TIMEOUT_MS - 1);
      expect(h.pbx.requests('CANCEL')).toHaveLength(0);
      expect(view(h)?.call.state).toBe('connecting');
      await advance(1);
      expect(h.pbx.requests('CANCEL')).toHaveLength(1);
      expect(view(h)?.call.state).toBe('ended');
      expect(view(h)?.endReasonKey).toBe(SILENT);
      expect(view(h)?.progress).toBe('calls.progress.ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a CANCEL that matches the INVITE it cancels (RFC 3261 9.1)', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(CALL_SETUP_TIMEOUT_MS);
      const cancel = h.pbx.requests('CANCEL')[0] as SipRequest;
      const original = invite(h);
      const branchOf = (r: SipRequest): string | undefined => /branch=([^;,\s]+)/.exec(headerValue(r.headers, 'via') ?? '')?.[1];
      expect(branchOf(cancel)).toBeDefined();
      expect(branchOf(cancel)).toBe(branchOf(original));
      expect(headerValue(cancel.headers, 'call-id')).toBe(headerValue(original.headers, 'call-id'));
      expect(headerValue(cancel.headers, 'from')).toBe(headerValue(original.headers, 'from'));
      expect(headerValue(cancel.headers, 'to')).toBe(headerValue(original.headers, 'to'));
      expect(headerValue(cancel.headers, 'to')).not.toContain('tag=');
      expect(headerValue(cancel.headers, 'cseq')).toBe('1 CANCEL');
      expect(cancel.uri).toBe(original.uri);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not extended by a stream of further 100 responses', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      for (let i = 0; i < 8; i += 1) {
        await advance(10 * SECOND);
        h.pbx.inject(reply(invite(h), 100));
      }
      await advance(9 * SECOND);
      expect(h.pbx.requests('CANCEL')).toHaveLength(0);
      await advance(SECOND);
      expect(h.pbx.requests('CANCEL')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('also releases the user from a far end that rings for 90 seconds and never answers', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 180)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(CALL_SETUP_TIMEOUT_MS - 1);
      expect(view(h)?.progress).toBe('calls.progress.ringing');
      expect(h.pbx.requests('CANCEL')).toHaveLength(0);
      h.pbx.inject(reply(invite(h), 183));
      await advance(1);
      expect(h.pbx.requests('CANCEL')).toHaveLength(1);
      expect(view(h)?.endReasonKey).toBe(SILENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the timeout at warn level', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(CALL_SETUP_TIMEOUT_MS);
      const entry = h.diagnostics.entries().find((e) => e.messageKey === SILENT);
      expect(entry?.level).toBe('warn');
      expect(entry?.accountId).toBe('acc1');
      expect(h.diagnostics.entries().filter((e) => e.messageKey === SILENT)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges the 487 that answers our CANCEL without changing the outcome', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(CALL_SETUP_TIMEOUT_MS);
      h.pbx.inject(reply(invite(h), 487));
      expect(h.pbx.requests('ACK')).toHaveLength(1);
      expect(view(h)?.endReasonKey).toBe(SILENT);
      expect(h.pbx.requests('CANCEL')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts from the first INVITE: a digest retry does not restart the clock', async () => {
    const h = await fakeClockHarness();
    try {
      h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
      await h.engine.dial('acc1', '55500000396');
      await advance(30 * SECOND);
      h.pbx.inject(reply(invite(h), 401, { 'www-authenticate': ['Digest realm="pbx", nonce="abc", algorithm=MD5, qop="auth"'] }));
      await advance(0);
      expect(h.pbx.requests('INVITE')).toHaveLength(2);
      await advance(60 * SECOND - 1);
      expect(h.pbx.requests('CANCEL')).toHaveLength(0);
      await advance(1);
      const cancel = h.pbx.requests('CANCEL')[0] as SipRequest;
      expect(headerValue(cancel.headers, 'cseq')).toBe('2 CANCEL');
      expect(headerValue(cancel.headers, 'via')).toBe(headerValue(invite(h, 1).headers, 'via'));
    } finally {
      vi.useRealTimers();
    }
  });

  describe('waiting message', () => {
    it('exports a grace period of 4 seconds', () => {
      expect(CALL_WAITING_GRACE_MS).toBe(4000);
    });

    it('stays on trying until the grace period passes after the first 100, then shows waiting', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
        await h.engine.dial('acc1', '55500000396');
        await advance(CALL_WAITING_GRACE_MS - 1);
        expect(view(h)?.progress).toBe(TRYING);
        await advance(1);
        expect(view(h)?.progress).toBe(WAITING);
        expect(h.diagnostics.entries().filter((e) => e.messageKey === WAITING)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is not undone by a repeated 100, and ringing replaces it', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : []);
        await h.engine.dial('acc1', '55500000396');
        await advance(CALL_WAITING_GRACE_MS);
        h.pbx.inject(reply(invite(h), 100));
        expect(view(h)?.progress).toBe(WAITING);
        h.pbx.inject(reply(invite(h), 180));
        expect(view(h)?.progress).toBe('calls.progress.ringing');
        h.pbx.inject(reply(invite(h), 100));
        expect(view(h)?.progress).toBe('calls.progress.ringing');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves ringing alone when the grace period ends', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 180)] : []);
        await h.engine.dial('acc1', '55500000396');
        await advance(CALL_WAITING_GRACE_MS + 1);
        expect(view(h)?.progress).toBe('calls.progress.ringing');
        expect(h.diagnostics.entries().some((e) => e.messageKey === WAITING)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never shows waiting for a call that was answered or refused inside the grace period', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 200, {}, ANSWER)] : []);
        await h.engine.dial('acc1', '1001');
        await advance(CALL_WAITING_GRACE_MS + 1);
        expect(view(h)?.progress).toBe('calls.progress.active');
        expect(h.diagnostics.entries().some((e) => e.messageKey === WAITING)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('timer hygiene', () => {
    it('is cleared by a final response: a 486 is never followed by a CANCEL', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 486)] : []);
        await h.engine.dial('acc1', '1002');
        await advance(CALL_SETUP_TIMEOUT_MS + 1);
        expect(h.pbx.requests('CANCEL')).toHaveLength(0);
        expect(h.diagnostics.entries().some((e) => e.messageKey === SILENT)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is cleared by a 200: an answered call is neither cancelled nor leaves a timer behind', async () => {
      const h = await fakeClockHarness();
      try {
        const before = vi.getTimerCount();
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 200, {}, ANSWER)] : []);
        await h.engine.dial('acc1', '1001');
        await advance(0);
        expect(vi.getTimerCount()).toBe(before);
        await advance(CALL_SETUP_TIMEOUT_MS + 1);
        expect(h.pbx.requests('CANCEL')).toHaveLength(0);
        expect(view(h)?.call.state).toBe('active');
      } finally {
        vi.useRealTimers();
      }
    });

    it('is cleared by a local hangup, leaving a single CANCEL', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100), reply(m, 180)] : []);
        const result = await h.engine.dial('acc1', '1003');
        await advance(SECOND);
        await h.engine.hangup((result as { callId: string }).callId);
        await advance(CALL_SETUP_TIMEOUT_MS + 1);
        expect(h.pbx.requests('CANCEL')).toHaveLength(1);
        expect(h.diagnostics.entries().some((e) => e.messageKey === SILENT)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is cleared by stop(): nothing fires afterwards', async () => {
      const h = await fakeClockHarness();
      try {
        h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 100)] : m.method === 'REGISTER' ? [reply(m, 200)] : []);
        await h.engine.dial('acc1', '55500000396');
        await advance(SECOND);
        const stopping = h.engine.stop();
        await advance(2 * SECOND);
        await stopping;
        const cancels = h.pbx.requests('CANCEL').length;
        await advance(CALL_SETUP_TIMEOUT_MS + 1);
        expect(h.pbx.requests('CANCEL')).toHaveLength(cancels);
        expect(h.diagnostics.entries().some((e) => e.messageKey === SILENT)).toBe(false);
        expect(h.diagnostics.entries().some((e) => e.messageKey === WAITING)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/* ------------------------------------------------------------------------
 * Another device holding the same account: the 200 OK lists every binding.
 * ---------------------------------------------------------------------- */

describe('engine account sharing', () => {
  const THEIRS = '<sip:1000@203.0.113.7:5070;transport=udp>;expires=300';
  const SHARED = 'logs.event.shared';
  const DISPLACED = 'logs.event.displaced';

  /** A registrar that echoes the Contact it was sent (unless `ours` is false) next to the given others. */
  const answering = (h: Harness, others: () => string[], ours: () => boolean = () => true): void => {
    h.pbx.respond = (m) => {
      if (m.method !== 'REGISTER') return [];
      const ourContact = `${headerValue(m.headers, 'contact') ?? ''};expires=300`;
      return [reply(m, 200, { expires: ['300'], contact: [...(ours() ? [ourContact] : []), ...others()] })];
    };
  };
  const start = async (h: Harness): Promise<void> => {
    const account = createAccount({ displayName: 'Me', username: '1000', password: 'secret', domain: 'pbx.test' }, 'acc1');
    await h.engine.startAccount(account);
    await vi.advanceTimersByTimeAsync(20);
  };
  const warned = (h: Harness, key: string): readonly unknown[] =>
    h.diagnostics.entries().filter((e) => e.messageKey === key && e.level === 'warn');

  it('reports nothing shared when only our contact is bound', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      answering(h, () => []);
      await start(h);
      expect(h.engine.getSharing()).toEqual({ acc1: { others: 0, displaced: false } });
      expect(warned(h, SHARED)).toHaveLength(0);
      expect(warned(h, DISPLACED)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports another device and logs it once at warn level', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      answering(h, () => [THEIRS]);
      await start(h);
      expect(h.engine.getSharing()).toEqual({ acc1: { others: 1, displaced: false } });
      const [entry] = h.diagnostics.entries().filter((e) => e.messageKey === SHARED);
      expect(entry?.level).toBe('warn');
      expect(entry?.params).toEqual({ contacts: 'sip:1000@203.0.113.7:5070' });
      expect(warned(h, DISPLACED)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repeat the log on a refresh that changes nothing, but logs again when it changes', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      let others = [THEIRS];
      answering(h, () => others);
      await start(h);
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(h.pbx.requests('REGISTER').length).toBeGreaterThanOrEqual(2);
      expect(warned(h, SHARED)).toHaveLength(1);
      others = [THEIRS, '<sip:1000@198.51.100.2:6000>;expires=60'];
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(warned(h, SHARED)).toHaveLength(2);
      expect(h.engine.getSharing()['acc1']).toEqual({ others: 2, displaced: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports displacement, logging it once, when ours is missing from the list', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      answering(h, () => [THEIRS], () => false);
      await start(h);
      expect(h.engine.getSharing()).toEqual({ acc1: { others: 1, displaced: true } });
      expect(warned(h, DISPLACED)).toHaveLength(1);
      expect(warned(h, SHARED)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(warned(h, DISPLACED)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the displacement again after it was resolved and then recurs', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      let ours = false;
      answering(h, () => [THEIRS], () => ours);
      await start(h);
      ours = true;
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(h.engine.getSharing()['acc1']).toEqual({ others: 1, displaced: false });
      ours = false;
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(warned(h, DISPLACED)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing, and does not claim displacement, when the 200 omits Contact', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      h.pbx.respond = (m) => (m.method === 'REGISTER' ? [reply(m, 200, { expires: ['300'], contact: [] })] : []);
      await start(h);
      expect(h.engine.getSharing()).toEqual({ acc1: { others: 0, displaced: false } });
      expect(warned(h, DISPLACED)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets what it knew when the account stops', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      answering(h, () => [THEIRS]);
      await start(h);
      const stopping = h.engine.stopAccount('acc1');
      await vi.advanceTimersByTimeAsync(2000);
      await stopping;
      expect(h.engine.getSharing()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets it when the registration fails, so a stale warning is not shown', async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      let refuse = false;
      h.pbx.respond = (m) => (m.method === 'REGISTER' ? [refuse ? reply(m, 403) : reply(m, 200, { expires: ['300'], contact: [THEIRS] })] : []);
      await start(h);
      expect(h.engine.getSharing()['acc1']?.others).toBe(1);
      refuse = true;
      await vi.advanceTimersByTimeAsync(300 * 1000);
      expect(h.engine.getSharing()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine inbound call', () => {
  const OFFER = ['v=0', 'o=- 1 1 IN IP4 203.0.113.9', 's=-', 'c=IN IP4 203.0.113.9', 't=0 0', 'm=audio 30000 RTP/AVP 0 8 101', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n');
  const invite = (body = OFFER): SipRequest => ({
    kind: 'request', method: 'INVITE', uri: 'sip:1000@10.0.0.5',
    headers: { via: ['SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bKx'], from: ['"Bob" <sip:2000@pbx.test>;tag=bobtag'], to: ['<sip:1000@pbx.test>'], 'call-id': ['in-1'], cseq: ['7 INVITE'], contact: ['<sip:2000@203.0.113.9:5060>'] },
    body
  });

  it('answers with our SDP, starts media on ACK, ends on BYE', async () => {
    const h = harness();
    await registered(h);
    h.pbx.inject(invite());
    await settle();
    expect(h.engine.getCallViews()[0]?.call.state).toBe('ringing');
    expect(h.pbx.sent.some((m) => m.kind === 'response' && m.status === 180)).toBe(true);
    await h.engine.answer('in-1');
    const ok = h.pbx.sent.filter((m): m is SipResponse => m.kind === 'response' && m.status === 200).pop() as SipResponse;
    expect(ok.body).toContain('m=audio 20000 RTP/AVP 0 101');
    expect(h.created).toHaveLength(0);
    h.pbx.inject({ kind: 'request', method: 'ACK', uri: 'x', headers: { 'call-id': ['in-1'], cseq: ['7 ACK'] }, body: '' });
    expect(h.created[0]?.options).toEqual({ localPort: 20000, remoteHost: '203.0.113.9', remotePort: 30000, payloadType: 0, dtmfPayloadType: 101 });
    expect(h.engine.getCallViews()[0]?.call.state).toBe('active');
    h.pbx.inject({ kind: 'request', method: 'BYE', uri: 'x', headers: { 'call-id': ['in-1'], cseq: ['8 BYE'], via: ['v'], from: ['f'], to: ['t'] }, body: '' });
    expect(h.engine.getCallViews()).toHaveLength(0);
    expect(h.created[0]?.session.close).toHaveBeenCalled();
  });

  it('restarts the RTP session when the peer re-INVITEs to a new media address', async () => {
    const h = harness();
    await registered(h);
    h.pbx.inject(invite());
    await settle();
    await h.engine.answer('in-1');
    h.pbx.inject({ kind: 'request', method: 'ACK', uri: 'x', headers: { 'call-id': ['in-1'], cseq: ['7 ACK'] }, body: '' });
    const moved = invite(OFFER.replace('m=audio 30000', 'm=audio 30002'));
    h.pbx.inject({ ...moved, headers: { ...moved.headers, cseq: ['8 INVITE'] } });
    await settle();
    expect(h.created).toHaveLength(2);
    expect(h.created[0]?.session.close).toHaveBeenCalled();
    expect(h.created[1]?.options.remotePort).toBe(30002);
    expect(h.created[1]?.options.localPort).toBe(20000);
    const last = h.pbx.sent[h.pbx.sent.length - 1] as SipResponse;
    expect([last.status, last.body.includes('m=audio 20000')]).toEqual([200, true]);
  });

  it('rejects an offer with no common codec with 488', async () => {
    const h = harness();
    await registered(h);
    h.pbx.inject(invite(OFFER.replace('0 8 101', '18 101')));
    await settle();
    expect(h.pbx.sent.some((m) => m.kind === 'response' && m.status === 488)).toBe(true);
    expect(h.engine.getCallViews()).toHaveLength(0);
  });
});


describe('UDP connection', () => {
  const candidate = { transport: 'udp', host: '203.0.113.5', port: 5060, source: 'a', weight: 0, srvPriority: 0 } as unknown as TransportCandidate;
  const ringing = 'SIP/2.0 180 Ringing\r\nCall-ID: abc\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n';
  type Fake = {
    connected: boolean;
    sent: { text: string; port: number | undefined; host: string | undefined }[];
    receive: (data: string, from: { address: string; port: number }, server: { host: string; port: number }) => void;
  };

  it('surfaces a response sent from a different source than the request destination', async () => {
    const connection = await openConnection(candidate);
    const seen: SipMessage[] = [];
    connection.onMessage((message) => seen.push(message));
    const socket = udp.sockets.at(-1) as Fake;
    socket.receive(ringing, { address: '198.51.100.9', port: 5088 }, candidate);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'response', status: 180 });
  });

  it('reports the bound local port and sends to an explicit destination', async () => {
    const connection = await openConnection(candidate);
    const socket = udp.sockets.at(-1) as Fake;
    expect(connection.localAddress).toEqual({ host: udp.lan, port: 40123 });
    expect(socket.connected).toBe(false);
    await connection.send({ kind: 'response', status: 200, reason: 'OK', headers: {}, body: '' } as unknown as SipMessage);
    expect(socket.sent[0]).toMatchObject({ port: 5060, host: '203.0.113.5' });
  });

  it('never reports the unspecified address as the local host of a wildcard-bound socket', async () => {
    const connection = await openConnection(candidate);
    expect(connection.localAddress.host).not.toBe('0.0.0.0');
    expect(connection.localAddress.host).toBe(udp.lan);
  });

  it('puts that address, never 0.0.0.0, in the Via sent-by of REGISTER and INVITE', async () => {
    const real = await openConnection(candidate);
    const ids = { newBranch: () => 'z9hG4bKtest', newTag: () => 'tag', newCallId: (h: string) => `cid@${h}`, newCnonce: () => 'cn' };
    const account = createAccount({ displayName: 'Me', username: '1000', password: 's', domain: 'pbx.test' }, 'acc1');
    const register = buildRegisterRequest({ account, candidate, expires: 300, localAddress: real.localAddress }, ids, 1);
    expect(headerValue(register.headers, 'via')).toBe(`SIP/2.0/UDP ${udp.lan}:40123;branch=z9hG4bKtest;rport`);
    const h = harness();
    Object.assign(h.pbx.connection, { localAddress: real.localAddress });
    await registered(h);
    await h.engine.dial('acc1', '1001');
    const invite = h.pbx.requests('INVITE')[0] as SipRequest;
    expect(headerValue(invite.headers, 'via')).toMatch(new RegExp(`^SIP/2\\.0/UDP ${udp.lan}:40123;branch=\\S+;rport$`));
    expect(JSON.stringify([register, invite])).not.toContain('0.0.0.0');
  });
});
