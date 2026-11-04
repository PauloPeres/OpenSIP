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
  closed = false;
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
      onClose: (l) => { this.closers.push(l); return () => undefined; },
      close: () => { this.closed = true; }
    } as SipConnection;
  }
  inject(m: SipMessage): void { this.handlers.forEach((h) => h(m)); }
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

interface Rig { engine: SipEngine; links: Link[]; diagnostics: ReturnType<typeof createDiagnosticsLog>; opens: () => number; failOpen: { next: boolean } }

/** Every REGISTER gets `registerStatus`; OPTIONS gets 200 unless `quiet` is set. */
const rig = (transport: TransportCandidate['transport'] = 'tcp'): Rig & { script: { register: (m: SipRequest, n: number) => SipResponse; quiet: boolean } } => {
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
        return m.method === 'OPTIONS' && !script.quiet ? [reply(m, 200)] : [];
      };
      links.push(link);
      return link.connection;
    },
    diagnostics, media: noMedia as never, random: () => 0.5,
    rtp: { allocatePort: async () => 20000, create: () => { throw new Error('no'); } }
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
const start = async (r: Rig): Promise<void> => { await r.engine.startAccount(account); await advance(1); };

beforeEach(() => vi.useFakeTimers());
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
  it('pings a UDP flow with OPTIONS every 20 s of silence, not before', async () => {
    const r = rig('udp');
    await start(r);
    await advance(19_000);
    expect(optionsPings(r)).toHaveLength(0);
    await advance(1_000);
    expect(optionsPings(r)).toHaveLength(1);
    await advance(19_000);
    expect(optionsPings(r)).toHaveLength(1);
    await advance(1_000);
    expect(optionsPings(r)).toHaveLength(2);
    expect(headerValue((optionsPings(r)[1] as SipRequest).headers, 'cseq')).toBe('2 OPTIONS');
  });

  it('pings a TCP flow only every 60 s', async () => {
    const r = rig('tcp');
    await start(r);
    await advance(55_000);
    expect(optionsPings(r)).toHaveLength(0);
    await advance(5_000);
    expect(optionsPings(r)).toHaveLength(1);
  });

  it('stays registered while the server answers', async () => {
    const r = rig('udp');
    await start(r);
    await advance(250 * SECOND);
    expect(stateOf(r)).toBe('registered');
    expect(r.opens()).toBe(1);
  });

  it('declares the flow dead after 60 s of silence, logs it, and registers again on a new connection', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    await advance(55_000);
    expect(stateOf(r)).toBe('registered');
    await advance(5_000);
    expect(stateOf(r)).toBe('failed');
    expect(keys(r)).toContain('logs.event.deadFlow');
    expect(r.links[0]?.closed).toBe(true);
    await advance(5_000);
    expect(r.opens()).toBe(2);
    expect(stateOf(r)).toBe('registered');
  });

  it('treats ANY inbound traffic as proof of life, such as the server own pings', async () => {
    const r = rig('udp');
    r.script.quiet = true;
    await start(r);
    const stray = { kind: 'response', status: 200, reason: 'OK', body: '', headers: { 'call-id': ['x'], cseq: ['1 OPTIONS'] } } as SipResponse;
    for (let i = 0; i < 6; i += 1) {
      await advance(30_000);
      r.links[0]?.inject(stray);
    }
    expect(stateOf(r)).toBe('registered');
    expect(r.opens()).toBe(1);
  });

  it('stops pinging when the account is turned off', async () => {
    const r = rig('udp');
    await start(r);
    await r.engine.stopAccount('acc1');
    expect(vi.getTimerCount()).toBe(0);
    await advance(120 * SECOND);
    expect(optionsPings(r)).toHaveLength(0);
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
