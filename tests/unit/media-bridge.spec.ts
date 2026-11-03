import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsLog } from '../../src/core/diagnostics';
import { createAccount, headerValue } from '../../src/core/sip';
import type { SipMessage, SipRequest, SipResponse } from '../../src/core/sip';
import type { MediaBridge } from '../../src/main/media/media-window';
import type { RtpSession, RtpSessionOptions } from '../../src/main/media/rtp-session';
import type { SipConnection } from '../../src/main/sip/connection';
import { SipEngine } from '../../src/main/sip/engine';
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
  const engine = new SipEngine({
    probe: { resolveSrv: async () => { throw new Error('nx'); }, probe: async () => 5, now: () => 0 },
    open: async () => pbx.connection,
    diagnostics, media,
    rtp: { allocatePort: async () => 20000, create: (options) => { const session = fakeSession(); created.push({ options, session }); return session as unknown as RtpSession; } }
  });
  return { pbx, engine, created, media, diagnostics };
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

  it('maps a 486 to an error, ACKs it, and ends the call', async () => {
    const h = harness();
    await registered(h);
    h.pbx.respond = (m) => (m.method === 'INVITE' ? [reply(m, 486)] : []);
    await h.engine.dial('acc1', '1002');
    await settle();
    expect(h.pbx.requests('ACK')).toHaveLength(1);
    expect(h.engine.getCallViews()).toHaveLength(0);
    expect(h.diagnostics.entries().some((e) => e.messageKey === 'calls.error.failed')).toBe(true);
    expect(h.created).toHaveLength(0);
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
