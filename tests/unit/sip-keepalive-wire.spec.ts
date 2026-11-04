import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket } from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticsLog } from '../../src/core/diagnostics';
import { createAccount, parse, serialize } from '../../src/core/sip';
import type { SipRequest, TransportCandidate } from '../../src/core/sip';
import { openConnection } from '../../src/main/sip/connection';
import type { ConnectionNotice, SipConnection } from '../../src/main/sip/connection';
import { SipEngine } from '../../src/main/sip/engine';

/*
 * These drive REAL UDP sockets on loopback: a stand-in server on one, the production connection on the
 * other, and for the dead-flow case the production engine on top. Nothing between them is faked, so what
 * is proved is what the wire does, not what a fake socket was told to do.
 */
vi.mock('../../src/main/windows', () => ({ log: (): void => undefined }));

const PING = '\r\n\r\n';
const PONG = '\r\n';

interface Server {
  readonly socket: Socket;
  readonly port: number;
  readonly heard: { text: string; from: RemoteInfo }[];
  /** Resolves with the next datagram the server receives that is exactly `text` (the client's own pings are ignored). */
  nextEqual(text: string): Promise<string>;
  /** Sends bytes to the last peer that wrote to the server. */
  say(data: string | Buffer): Promise<void>;
  close(): void;
}

async function startServer(onMessage?: (text: string, from: RemoteInfo, server: Server) => void): Promise<Server> {
  const socket = createSocket('udp4');
  const heard: Server['heard'] = [];
  const waiting: { text: string; resolve: (text: string) => void }[] = [];
  const server: Server = {
    socket,
    port: 0,
    heard,
    nextEqual: (text) => new Promise((resolve) => waiting.push({ text, resolve })),
    say: (data) => new Promise((resolve) => {
      const peer = heard.at(-1)?.from;
      socket.send(data, peer?.port, peer?.address, () => resolve());
    }),
    close: () => socket.close()
  };
  socket.on('message', (data, from) => {
    const text = data.toString('utf8');
    heard.push({ text, from });
    waiting.filter((w) => w.text === text).forEach((w) => { waiting.splice(waiting.indexOf(w), 1); w.resolve(text); });
    onMessage?.(text, from, server);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return Object.assign(server, { port: socket.address().port });
}

const candidateFor = (server: Server): TransportCandidate =>
  ({ transport: 'udp', host: '127.0.0.1', port: server.port, source: 'manual', weight: 0, srvPriority: 0 }) as TransportCandidate;

/** Real time: lets socket events be delivered even while the timers under test are fake. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

const open = new Set<() => void>();
afterEach(() => { open.forEach((close) => close()); open.clear(); vi.useRealTimers(); });
const track = <T extends { close(): void }>(item: T): T => { open.add(() => item.close()); return item; };

describe('a CRLF keepalive on a real UDP socket', () => {
  async function connect(): Promise<{ server: Server; connection: SipConnection; notices: ConnectionNotice[]; activity: { count: number } }> {
    const server = track(await startServer());
    const notices: ConnectionNotice[] = [];
    const activity = { count: 0 };
    const connection = track(await openConnection(candidateFor(server), { onNotice: (notice) => notices.push(notice) }));
    connection.onActivity(() => { activity.count += 1; });
    await connection.sendKeepalive();
    await until(() => server.heard.length === 1);
    return { server, connection, notices, activity };
  }

  it('is answered with a CRLF pong, counted as activity, and never reported as an unreadable datagram', async () => {
    const { server, notices, activity } = await connect();
    const pong = server.nextEqual(PONG);
    await server.say(PING);
    expect(await pong).toBe(PONG);
    expect(activity.count).toBe(1);
    expect(notices).toEqual([]);
  });

  it('is not answered when it is itself a pong, but still counts as activity', async () => {
    const { server, notices, activity } = await connect();
    await server.say(PONG);
    await until(() => activity.count === 1);
    expect(server.heard).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('shows the bytes of an unreadable datagram that is not a keepalive, so it can be identified', async () => {
    const { server, notices, activity } = await connect();
    await server.say(Buffer.from([0, 0, 0, 0]));
    await until(() => notices.length === 1);
    expect(notices[0]?.params).toMatchObject({ bytes: '4', prefix: '\\x00\\x00\\x00\\x00' });
    expect(activity.count).toBe(1);
  });
});

describe('dead-flow detection against a server that sends nothing but CRLF pings', () => {
  const SECOND = 1000;
  const account = createAccount(
    { displayName: 'Me', username: '1000', password: 'secret', domain: 'pbx.test', serverUri: 'udp://127.0.0.1:5060' },
    'acc1'
  );

  function answerRegister(text: string, from: RemoteInfo, server: Server): void {
    if (!text.startsWith('REGISTER')) return;
    const request = parse(text) as SipRequest;
    const h = request.headers;
    const ok = {
      kind: 'response' as const, status: 200, reason: 'OK', body: '',
      headers: {
        via: [`${(h['via'] ?? [''])[0]};received=${from.address};rport=${from.port}`],
        from: h['from'] ?? [], to: [`${(h['to'] ?? [''])[0]};tag=srv`], 'call-id': h['call-id'] ?? [], cseq: h['cseq'] ?? [],
        contact: [`<sip:1000@${from.address}:${from.port}>;expires=300`], expires: ['300']
      }
    };
    server.socket.send(serialize(ok), from.port, from.address);
  }

  async function engineAgainst(server: Server): Promise<{ engine: SipEngine; opens: () => number; keys: () => string[] }> {
    const diagnostics = createDiagnosticsLog({ debug: false });
    let opened = 0;
    const engine = new SipEngine({
      probe: { resolveSrv: async () => { throw new Error('nx'); }, probe: async () => 5, now: () => 0 },
      open: async (candidate) => { opened += 1; return openConnection({ ...candidate, port: server.port }); },
      diagnostics, random: () => 0.5, onCallRecorded: () => undefined,
      media: { start: vi.fn(), stop: vi.fn(), play: vi.fn(), onCapture: vi.fn(() => () => undefined), dispose: vi.fn() } as never,
      rtp: { allocatePort: async () => 20000, create: vi.fn() } as never
    });
    track({ close: () => void engine.stop() });
    return { engine, opens: () => opened, keys: () => diagnostics.entries().map((e) => e.messageKey) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  it('never declares the flow dead, and never replaces the connection, over two minutes of pings alone', async () => {
    const server = track(await startServer(answerRegister));
    const { engine, opens, keys } = await engineAgainst(server);
    await engine.startAccount(account);
    await until(() => engine.getRegistrations()['acc1']?.state === 'registered');
    for (let tick = 0; tick < 12; tick += 1) {
      const answered = server.nextEqual(PONG);
      await server.say(PING);
      expect(await answered).toBe(PONG);
      await vi.advanceTimersByTimeAsync(10 * SECOND);
    }
    expect(keys()).not.toContain('logs.event.deadFlow');
    expect(opens()).toBe(1);
    expect(engine.getRegistrations()['acc1']?.state).toBe('registered');
  });

  it('does declare it dead when the server is genuinely silent for the same two minutes', async () => {
    const server = track(await startServer(answerRegister));
    const { engine, keys } = await engineAgainst(server);
    await engine.startAccount(account);
    await until(() => engine.getRegistrations()['acc1']?.state === 'registered');
    await vi.advanceTimersByTimeAsync(65 * SECOND);
    expect(keys()).toContain('logs.event.deadFlow');
  });
});
