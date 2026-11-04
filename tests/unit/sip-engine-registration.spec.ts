import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticsLog } from '../../src/core/diagnostics';
import { createAccount, headerValue } from '../../src/core/sip';
import type { SipMessage, SipRequest, SipResponse, TransportCandidate } from '../../src/core/sip';
import type { SipConnection } from '../../src/main/sip/connection';
import { SipEngine, resumeAllEngines } from '../../src/main/sip/engine';

vi.mock('../../src/main/windows', () => ({ log: (): void => undefined }));

const SECOND = 1000;
const noMedia = { start: vi.fn(), stop: vi.fn(), play: vi.fn(), onCapture: vi.fn(() => () => undefined), dispose: vi.fn() };

class Link {
  readonly sent: SipMessage[] = [];
  private readonly handlers: ((m: SipMessage) => void)[] = [];
  private readonly closers: ((reason: string) => void)[] = [];
  private readonly listeners: (() => void)[] = [];
  closed = false;
  /** How many CRLF pings were put on the wire. */
  keepalives = 0;
  /** True while the server stays silent: it neither answers pings nor sends any of its own. */
  quiet: () => boolean = () => false;
  respond: (m: SipRequest) => SipResponse[] = () => [];
  readonly connection: SipConnection;

  constructor(transport: TransportCandidate['transport']) {
    this.connection = {
      candidate: { transport, host: 'pbx.test', port: 5060, source: 'manual' } as never,
      localAddress: { host: '10.0.0.5', port: 5060 },
      send: async (m) => {
        this.sent.push(m);
        if (m.kind === 'request') for (const r of this.respond(m)) queueMicrotask(() => this.inject(r));
      },
      onMessage: (l) => { this.handlers.push(l); return () => undefined; },
      onActivity: (l) => { this.listeners.push(l); return () => undefined; },
      sendKeepalive: async () => { this.keepalives += 1; if (!this.quiet()) queueMicrotask(() => this.hear()); },
      onClose: (l) => { this.closers.push(l); return () => undefined; },
      close: () => { this.closed = true; }
    } as SipConnection;
  }
  inject(m: SipMessage): void { this.hear(); this.handlers.forEach((h) => h(m)); }
  /** A packet that is not a SIP message at all: the server's CRLF ping, or a datagram that failed to parse. */
  hear(): void { this.listeners.forEach((l) => l()); }
  drop(reason = 'ECONNRESET'): void { this.closers.forEach((c) => c(reason)); }
  requests(method: string): SipRequest[] { return this.sent.filter((m): m is SipRequest => m.kind === 'request' && m.method === method); }
}

function reply(req: SipRequest, status: number, extra: Record<string, string[]> = {}): SipResponse {
  const h = req.headers;
  return {
    kind: 'response', status, reason: 'X', body: '',
    headers: {
      via: [`${(h['via'] ?? [''])[0]};received=198.51.100.7;rport=5099`],
      from: h['from'] ?? [], to: h['to'] ?? [], 'call-id': h['call-id'] ?? [], cseq: h['cseq'] ?? [],
      contact: ['<sip:1000@198.51.100.7:5099>'], ...extra
    }
  };
}

const SDP = ['v=0', 'o=- 1 1 IN IP4 203.0.113.9', 's=-', 'c=IN IP4 203.0.113.9', 't=0 0', 'm=audio 40000 RTP/AVP 8 101', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n');

function answerInvite(m: SipRequest): SipResponse {
  const to = headerValue(m.headers, 'to') ?? '';
  const answered = reply(m, 200, { to: [`${to};tag=pbx1`], 'content-type': ['application/sdp'] });
  return { ...answered, body: SDP };
}

/** The inbound RTP packet count the fake media session reports; a test moves it to stand for audio arriving. */
const media = { rx: 0 };

type ScriptedRig = Rig & { script: { register: (m: SipRequest, n: number) => SipResponse; quiet: boolean } };

interface Rig { engine: SipEngine; links: Link[]; diagnostics: ReturnType<typeof createDiagnosticsLog>; opens: () => number; failOpen: { next: boolean } }

/** Every REGISTER gets `registerStatus`; a ping is answered, and OPTIONS gets 200, unless `quiet` is set. */
const rig = (transport: TransportCandidate['transport'] = 'tcp'): ScriptedRig => {
  const links: Link[] = [];
  const failOpen = { next: false };
  // Annotated so an override may take the attempt count; the default ignores it.
  const script: { register: (m: SipRequest, n: number) => SipResponse; quiet: boolean } = {
    register: (m: SipRequest): SipResponse => reply(m, 200, { expires: ['300'] }),
    quiet: false
  };
  const diagnostics = createDiagnosticsLog({ debug: false });
  const engine = new SipEngine({
    probe: { resolveSrv: async () => { throw new Error('nx'); }, probe: async () => 5, now: () => 0 },
    open: async () => {
      if (failOpen.next) { failOpen.next = false; throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }
      const link = new Link(transport);
      link.respond = (m) => {
        if (m.method === 'REGISTER') return [script.register(m, links.flatMap((l) => l.requests('REGISTER')).length)];
        if (m.method === 'INVITE') return [answerInvite(m)];
        return m.method === 'OPTIONS' && !script.quiet ? [reply(m, 200)] : [];
      };
      link.quiet = () => script.quiet;
      links.push(link);
      return link.connection;
    },
    diagnostics, media: noMedia as never, random: () => 0.5,
    rtp: {
      allocatePort: async () => 20000,
      create: () => ({
        sendPcm: vi.fn(), onPcm: vi.fn(() => () => undefined), sendDtmf: vi.fn(), setMuted: vi.fn(), setHeld: vi.fn(), close: vi.fn(),
        localPort: 20000, get stats() { return { rxPackets: media.rx, txPackets: 0, lostPackets: 0, muted: false }; }
      }) as never
    }
  });
  return { engine, links, diagnostics, opens: () => links.length, failOpen, script };
};

const account = createAccount({ displayName: 'Me', username: '1000', password: 'secret', domain: 'pbx.test' }, 'acc1');
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const registers = (r: Rig): SipRequest[] => r.links.flatMap((l) => l.requests('REGISTER'));
const optionsPings = (r: Rig): SipRequest[] => r.links.flatMap((l) => l.requests('OPTIONS'));
const stateOf = (r: Rig): string | undefined => r.engine.getRegistrations()['acc1']?.state;
const keys = (r: Rig): string[] => r.diagnostics.entries().map((e) => e.messageKey);
const advanceUntil = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i += 1) await advance(1_000);
};
const start = async (r: Rig): Promise<void> => { await r.engine.startAccount(account); await advance(1); };

beforeEach(() => { media.rx = 0; vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('registration retry', () => {
  it.each([408, 480, 500, 502, 503, 504, 600, 603, 699])('retries after a %i, first after exactly the base delay', async (status) => {
    const r = rig();
    r.script.register = (m, n) => (n === 1 ? reply(m, status) : reply(m, 200));
    await start(r);
    expect(stateOf(r)).toBe('failed');
    await advance(4_980);
    expect(registers(r)).toHaveLength(1);
    await advance(20);
    expect(registers(r)).toHaveLength(2);
    expect(stateOf(r)).toBe('registered');
  });

  it.each([401, 403, 404, 400, 405, 486, 501, 505])('does not retry a %i', async (status) => {
    const r = rig();
    r.script.register = (m) => reply(m, status);
    await start(r);
    await advance(7_200 * SECOND);
    expect(registers(r)).toHaveLength(1);
    expect(stateOf(r)).toBe('failed');
  });

  it('does not retry a repeated-nonce credential failure', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 401, { 'www-authenticate': ['Digest realm="pbx", nonce="same", algorithm=MD5'] });
    await start(r);
    await advance(3_600 * SECOND);
    expect(stateOf(r)).toBe('failed');
    expect(registers(r)).toHaveLength(2);
    expect(keys(r)).not.toContain('logs.event.retry');
  });

  it('keeps retrying with doubling waits, well past three attempts', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 503);
    await start(r);
    expect(registers(r)).toHaveLength(1);
    await advance(5_000);
    expect(registers(r)).toHaveLength(2);
    await advance(9_998);
    expect(registers(r)).toHaveLength(2);
    await advance(1);
    expect(registers(r)).toHaveLength(3);
    await advance(20_000);
    expect(registers(r)).toHaveLength(4);
    await advance(40_000);
    expect(registers(r)).toHaveLength(5);
    await advance(80_000 + 160_000 + 300_000 + 300_000);
    expect(registers(r)).toHaveLength(9);
    expect(stateOf(r)).toBe('failed');
  });

  it('announces each wait in the log', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 503);
    await start(r);
    await advance(5_000);
    const waits = r.diagnostics.entries().filter((e) => e.messageKey === 'logs.event.retry').map((e) => e.params?.['seconds']);
    expect(waits).toEqual(['5', '10']);
  });

  it('honours Retry-After on a 503', async () => {
    const r = rig();
    r.script.register = (m, n) => (n === 1 ? reply(m, 503, { 'retry-after': ['120'] }) : reply(m, 200));
    await start(r);
    await advance(119_998);
    expect(registers(r)).toHaveLength(1);
    await advance(2);
    expect(registers(r)).toHaveLength(2);
  });

  it('retries after the connection drops, and after the transport cannot be opened', async () => {
    const r = rig();
    await start(r);
    expect(stateOf(r)).toBe('registered');
    r.failOpen.next = true;
    r.links[0]?.drop();
    expect(stateOf(r)).toBe('failed');
    await advance(5_000);
    expect(r.opens()).toBe(1);
    expect(stateOf(r)).toBe('failed');
    await advance(10_000);
    expect(r.opens()).toBe(2);
    expect(stateOf(r)).toBe('registered');
  });

  it('starts the backoff over once an attempt succeeds', async () => {
    const r = rig();
    r.script.register = (m, n) => (n <= 2 ? reply(m, 503) : reply(m, 200, { expires: ['300'] }));
    await start(r);
    await advance(5_000 + 10_000);
    expect(stateOf(r)).toBe('registered');
    r.script.register = (m) => reply(m, 503);
    await advance(270_000);
    expect(stateOf(r)).toBe('failed');
    const before = registers(r).length;
    await advance(4_998);
    expect(registers(r)).toHaveLength(before);
    await advance(2);
    expect(registers(r)).toHaveLength(before + 1);
  });

  it('stops retrying when the account is turned off', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 503);
    await start(r);
    await r.engine.stopAccount('acc1');
    await advance(600 * SECOND);
    expect(registers(r)).toHaveLength(1);
  });
});

describe('423 Interval Too Brief', () => {
  it('re-registers at once with the Min-Expires, never showing a failure, and keeps using it', async () => {
    const r = rig();
    r.script.register = (m) => {
      const expires = headerValue(m.headers, 'expires');
      return expires === '3600' ? reply(m, 200, { expires: ['3600'] }) : reply(m, 423, { 'min-expires': ['3600'] });
    };
    await start(r);
    const sent = registers(r).map((m) => headerValue(m.headers, 'expires'));
    expect(sent).toEqual(['600', '3600']);
    expect(stateOf(r)).toBe('registered');
    expect(keys(r)).not.toContain('logs.event.failed');
    await advance(3_240 * SECOND);
    expect(registers(r).map((m) => headerValue(m.headers, 'expires'))).toEqual(['600', '3600', '3600']);
  });

  it('fails without retrying when the 423 has no usable Min-Expires', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 423);
    await start(r);
    await advance(3_600 * SECOND);
    expect(registers(r)).toHaveLength(1);
    expect(stateOf(r)).toBe('failed');
  });

  it('does not loop on a server whose Min-Expires keeps rising', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 423, { 'min-expires': [String(Number(headerValue(m.headers, 'expires')) + 1)] });
    await start(r);
    expect(registers(r).length).toBeGreaterThan(1);
    expect(registers(r).length).toBeLessThan(5);
  });
});

describe('resume from sleep', () => {
  it('re-registers a registered account at once instead of waiting for the refresh timer', async () => {
    const r = rig();
    await start(r);
    await advance(60 * SECOND);
    r.engine.reregisterAll();
    await advance(10);
    expect(registers(r)).toHaveLength(2);
    expect(stateOf(r)).toBe('registered');
    await advance(270 * SECOND - 10);
    expect(registers(r)).toHaveLength(3);
  });

  it('retries a failed account that was waiting out a backoff, immediately', async () => {
    const r = rig();
    r.script.register = (m, n) => (n === 1 ? reply(m, 503) : reply(m, 200));
    await start(r);
    r.engine.reregisterAll();
    await advance(10);
    expect(stateOf(r)).toBe('registered');
    await advance(5_000);
    expect(registers(r).length).toBeLessThanOrEqual(3);
  });

  it('leaves a terminally failed account alone', async () => {
    const r = rig();
    r.script.register = (m) => reply(m, 403);
    await start(r);
    r.engine.reregisterAll();
    await advance(60 * SECOND);
    expect(registers(r)).toHaveLength(1);
  });

  it('does nothing, and says nothing, when there is no account', async () => {
    const r = rig();
    r.engine.reregisterAll();
    await advance(60 * SECOND);
    expect(keys(r)).toEqual([]);
    expect(r.opens()).toBe(0);
  });

  it('notes the wake in the log when it acts', async () => {
    const r = rig();
    await start(r);
    r.engine.reregisterAll();
    expect(keys(r)).toContain('logs.event.resumed');
  });
});

describe('keepalive and dead-flow detection', () => {
  const pings = (r: Rig): number => r.links.reduce((sum, l) => sum + l.keepalives, 0);
  const hangups = (r: Rig): SipRequest[] => r.links.flatMap((l) => l.requests('BYE'));
  const reinvites = (r: Rig, index: number): SipRequest[] => (r.links[index]?.requests('INVITE') ?? []);
  const callStates = (r: Rig): string[] => r.engine.getCallViews().map((view) => view.call.state);

  async function withActiveCall(transport: TransportCandidate['transport'] = 'udp'): Promise<ScriptedRig> {
    const r = rig(transport);
    r.script.quiet = true;
    await start(r);
    await r.engine.dial('acc1', '1001');
    await advance(50);
    expect(callStates(r)).toEqual(['active']);
    return r;
  }

  it('pings a UDP flow with a CRLF ping, not an OPTIONS request, every 20 s of silence', async () => {
    const r = rig('udp');
    await start(r);
    await advance(19_000);
    expect(pings(r)).toBe(0);
    await advance(1_000);
    expect(pings(r)).toBe(1);
    await advance(19_000);
    expect(pings(r)).toBe(1);
    await advance(1_000);
    expect(pings(r)).toBe(2);
    expect(optionsPings(r)).toHaveLength(0);
  });

  it('pings a TCP flow with a CRLF ping only every 60 s', async () => {
    const r = rig('tcp');
    await start(r);
    await advance(55_000);
    expect(pings(r)).toBe(0);
    await advance(5_000);
    expect(pings(r)).toBe(1);
    expect(optionsPings(r)).toHaveLength(0);
  });

  it('keeps an OPTIONS request as the ping over WebSocket, where CRLF is not valid SIP', async () => {
    const r = rig('ws');
    await start(r);
    await advance(60_000);
    expect(optionsPings(r)).toHaveLength(1);
    expect(pings(r)).toBe(0);
    expect(headerValue((optionsPings(r)[0] as SipRequest).headers, 'cseq')).toBe('1 OPTIONS');
  });

  it('stays registered when the server ignores pings but speaks now and then', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    for (let i = 0; i < 10; i += 1) {
      await advance(30_000);
      r.links[0]?.hear();
    }
    expect(stateOf(r)).toBe('registered');
    expect(r.opens()).toBe(1);
  });

  it('counts the server own CRLF ping, which is no SIP message at all, as proof of life', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    for (let i = 0; i < 25; i += 1) {
      await advance(10_000);
      r.links[0]?.hear();
    }
    expect(stateOf(r)).toBe('registered');
    expect(keys(r)).not.toContain('logs.event.deadFlow');
    expect(r.opens()).toBe(1);
  });

  it('does not declare a UDP flow dead one tick before the threshold, and does on the tick that reaches it', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    await advance(55_000);
    expect(keys(r)).not.toContain('logs.event.deadFlow');
    expect(r.opens()).toBe(1);
    await advance(5_000);
    expect(keys(r)).toContain('logs.event.deadFlow');
    expect(r.opens()).toBe(2);
  });

  it('declares the flow dead after 60 s of silence, logs it, and registers again on a new connection', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    await advance(60_000);
    expect(keys(r)).toContain('logs.event.deadFlow');
    expect(r.links[0]?.closed).toBe(true);
    await advance(10);
    expect(r.opens()).toBe(2);
    expect(stateOf(r)).toBe('registered');
    expect(registers(r)).toHaveLength(2);
  });

  it('gives a stream flow three minutes, not one', async () => {
    const r = rig('tcp');
    r.script.quiet = true;
    await start(r);
    await advance(175_000);
    expect(r.opens()).toBe(1);
    await advance(5_000);
    expect(r.opens()).toBe(2);
  });

  it('stops pinging when the account is turned off', async () => {
    const r = rig('udp');
    await start(r);
    await r.engine.stopAccount('acc1');
    expect(vi.getTimerCount()).toBe(0);
    await advance(120 * SECOND);
    expect(pings(r)).toBe(0);
  });

  it('restarts the dead-flow clock on resume, so a long sleep is not mistaken for silence', async () => {
    const r = rig('udp');
    await start(r);
    vi.setSystemTime(Date.now() + 3_600 * SECOND);
    r.engine.reregisterAll();
    await advance(10);
    expect(stateOf(r)).toBe('registered');
    expect(r.opens()).toBe(1);
  });

  describe('with a call in progress', () => {
    it('never declares the flow dead while RTP keeps arriving, and does not touch the call', async () => {
      const r = await withActiveCall();
      for (let i = 0; i < 60; i += 1) {
        media.rx += 250;
        await advance(5_000);
      }
      expect(r.opens()).toBe(1);
      expect(stateOf(r)).toBe('registered');
      expect(callStates(r)).toEqual(['active']);
      expect(hangups(r)).toHaveLength(0);
    });

    it('re-registers on a new connection when signalling AND media have been silent, without ending the call', async () => {
      const r = await withActiveCall();
      media.rx = 100;
      await advanceUntil(() => r.opens() === 2);
      await advance(100);
      expect(keys(r)).toContain('logs.event.deadFlow');
      expect(r.opens()).toBe(2);
      expect(r.links[0]?.closed).toBe(true);
      expect(stateOf(r)).toBe('registered');
      expect(callStates(r)).toEqual(['active']);
      expect(hangups(r)).toHaveLength(0);
    });

    it('keeps the call through the registration of the new connection even when that REGISTER fails once', async () => {
      const r = await withActiveCall();
      r.script.register = (m, n) => (n === 2 ? reply(m, 503) : reply(m, 200, { expires: ['300'] }));
      await advanceUntil(() => stateOf(r) === 'failed');
      expect(callStates(r)).toEqual(['active']);
      await advanceUntil(() => stateOf(r) === 'registered');
      expect(stateOf(r)).toBe('registered');
      expect(callStates(r)).toEqual(['active']);
      expect(hangups(r)).toHaveLength(0);
    });

    it('hangs up through the NEW connection afterwards: the dialog follows the entry, not the dead socket', async () => {
      const r = await withActiveCall();
      await advanceUntil(() => r.opens() === 2);
      await advance(100);
      const view = r.engine.getCallViews()[0];
      await r.engine.hangup(view?.call.id as string);
      expect(r.links[1]?.requests('BYE')).toHaveLength(1);
      expect(r.links[0]?.requests('BYE')).toHaveLength(0);
      expect(headerValue((r.links[1]?.requests('BYE')[0] as SipRequest).headers, 'via')).toContain('10.0.0.5:5060');
    });

    it('tells the far end where we are now with a re-INVITE on the new connection (RFC 3261 12.2.1.1 target refresh)', async () => {
      const r = await withActiveCall();
      await advanceUntil(() => r.opens() === 2);
      await advance(100);
      expect(reinvites(r, 1)).toHaveLength(1);
      expect(headerValue((reinvites(r, 1)[0] as SipRequest).headers, 'contact')).toContain('transport=udp');
      await advance(60_000);
      expect(reinvites(r, 1)).toHaveLength(1);
    });

    it('does not send that re-INVITE after an ordinary registration refresh', async () => {
      const r = await withActiveCall();
      for (let i = 0; i < 60; i += 1) {
        media.rx += 250;
        await advance(5_000);
      }
      expect(registers(r).length).toBeGreaterThan(1);
      expect(r.opens()).toBe(1);
      expect(reinvites(r, 0)).toHaveLength(1);
    });

    it.each([408, 480, 500, 503, 504, 603])('keeps the call when a refresh REGISTER fails with %i, and recovers on its own', async (status) => {
      const r = await withActiveCall();
      let refused = false;
      r.script.register = (m, n) => (n === 2 && !refused ? ((refused = true), reply(m, status)) : reply(m, 200, { expires: ['300'] }));
      for (let i = 0; i < 100 && !refused; i += 1) { media.rx += 250; await advance(5_000); }
      expect(refused).toBe(true);
      expect(stateOf(r)).toBe('failed');
      expect(callStates(r)).toEqual(['active']);
      for (let i = 0; i < 12; i += 1) { media.rx += 250; await advance(5_000); }
      expect(stateOf(r)).toBe('registered');
      expect(callStates(r)).toEqual(['active']);
      expect(hangups(r)).toHaveLength(0);
    });

    it('keeps the call when a credential failure ends the retries; only the user can fix that registration', async () => {
      const r = await withActiveCall();
      r.script.register = (m, n) => (n === 1 ? reply(m, 200, { expires: ['300'] }) : reply(m, 403));
      for (let i = 0; i < 100 && stateOf(r) !== 'failed'; i += 1) { media.rx += 250; await advance(5_000); }
      expect(stateOf(r)).toBe('failed');
      expect(callStates(r)).toEqual(['active']);
    });

    it('keeps the call when the transport closes, reopens, and tells the far end the new address', async () => {
      const r = await withActiveCall();
      r.links[0]?.drop('ECONNRESET');
      await advanceUntil(() => r.opens() === 2);
      await advance(100);
      expect(stateOf(r)).toBe('registered');
      expect(callStates(r)).toEqual(['active']);
      expect(hangups(r)).toHaveLength(0);
      expect(reinvites(r, 1)).toHaveLength(1);
      const view = r.engine.getCallViews()[0];
      await r.engine.hangup(view?.call.id as string);
      expect(r.links[1]?.requests('BYE')).toHaveLength(1);
    });

    it('does not send a target-refresh re-INVITE when no call is up', async () => {
      const r = rig('udp');
      await start(r);
      r.links[0]?.drop();
      await advanceUntil(() => r.opens() === 2);
      await advance(100);
      expect(r.links[1]?.requests('INVITE')).toHaveLength(0);
    });

    it('ends the call when the far end hangs up, whatever the registration is doing', async () => {
      const r = await withActiveCall();
      r.links[0]?.drop();
      await advance(10);
      const bye = { kind: 'request', method: 'BYE', uri: 'sip:1000@x', body: '', headers: { ...(r.links[0]?.requests('INVITE')[0] as SipRequest).headers, via: ['SIP/2.0/UDP pbx.test'], from: [(headerValue((r.links[0]?.requests('INVITE')[0] as SipRequest).headers, 'to') ?? '') + ';tag=pbx1'], to: [headerValue((r.links[0]?.requests('INVITE')[0] as SipRequest).headers, 'from') ?? ''], cseq: ['9 BYE'] } } as SipRequest;
      r.links[0]?.inject(bye);
      expect(callStates(r)).toEqual([]);
    });

    it('does end the call when the account is turned off', async () => {
      const r = await withActiveCall();
      await r.engine.stopAccount('acc1');
      expect(callStates(r).every((state) => state === 'ended')).toBe(true);
    });

    it('does not crash a hang-up made while the connection is gone, between a failed reopen and the retry', async () => {
      const r = await withActiveCall();
      r.failOpen.next = true;
      await advanceUntil(() => stateOf(r) === 'failed');
      expect(stateOf(r)).toBe('failed');
      expect(callStates(r)).toEqual(['active']);
      const view = r.engine.getCallViews()[0];
      await expect(r.engine.hangup(view?.call.id as string)).resolves.toBeUndefined();
    });
  });
});

describe('resumeAllEngines (the powerMonitor hook)', () => {
  it('wakes every live engine, and no longer a stopped one', async () => {
    const r = rig();
    await start(r);
    resumeAllEngines();
    await advance(1);
    expect(registers(r)).toHaveLength(2);
    await r.engine.stop();
    resumeAllEngines();
    await advance(1);
    expect(registers(r).filter((m) => headerValue(m.headers, 'expires') !== '0')).toHaveLength(2);
  });
});
