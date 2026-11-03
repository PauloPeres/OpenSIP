import { resolveSrv as dnsResolveSrv } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  SRV_SERVICES,
  TRANSPORT_ERROR_KEYS,
  buildCandidates,
  orderCandidates,
  selectBestCandidate,
  srvQueryNames
} from '@core/sip';
import type { ProbeOutcome, SrvRecord, TransportCandidate } from '@core/sip';
import { USER_AGENT } from './user-agent';

export interface ProbeDeps {
  resolveSrv(
    name: string
  ): Promise<readonly { name: string; port: number; priority: number; weight: number }[]>;
  /** Resolves with the latency in ms; rejects on failure. */
  probe(candidate: TransportCandidate, timeoutMs: number): Promise<number>;
  now(): number;
}

export interface ProbeSettings {
  readonly timeoutMs: number;
}

export const DEFAULT_PROBE_SETTINGS: ProbeSettings = { timeoutMs: 2500 };

const ERROR_KEY_BY_CODE: Readonly<Record<string, string>> = {
  ETIMEDOUT: 'transport.error.timeout',
  ECONNREFUSED: 'transport.error.refused',
  ECONNRESET: 'transport.error.refused',
  ENOTFOUND: 'transport.error.dns',
  EAI_AGAIN: 'transport.error.dns'
};

function errorKeyOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (code.startsWith('ERR_TLS') || code.startsWith('CERT_')) return 'transport.error.tls';
    const mapped = ERROR_KEY_BY_CODE[code];
    if (mapped !== undefined) return mapped;
  }
  return error instanceof Error && error.message === 'timeout'
    ? 'transport.error.timeout'
    : TRANSPORT_ERROR_KEYS.noneReachable;
}

async function srvFor(
  deps: ProbeDeps,
  name: string,
  transport: SrvRecord['transport']
): Promise<readonly SrvRecord[]> {
  try {
    const answers = await deps.resolveSrv(name);
    return answers.map((answer) => ({ ...answer, transport }));
  } catch {
    return [];
  }
}

async function collectSrv(domain: string, deps: ProbeDeps): Promise<readonly SrvRecord[]> {
  const names = srvQueryNames(domain);
  const answers = await Promise.all(
    names.map((name, index) => srvFor(deps, name, (SRV_SERVICES[index] as { transport: SrvRecord['transport'] }).transport))
  );
  return answers.flat();
}

async function attempt(
  candidate: TransportCandidate,
  deps: ProbeDeps,
  timeoutMs: number
): Promise<ProbeOutcome> {
  try {
    return { candidate, ok: true, latencyMs: await deps.probe(candidate, timeoutMs) };
  } catch (error) {
    return { candidate, ok: false, errorKey: errorKeyOf(error) };
  }
}

async function probeInOrder(
  candidates: readonly TransportCandidate[],
  deps: ProbeDeps,
  timeoutMs: number
): Promise<readonly ProbeOutcome[]> {
  const outcomes: ProbeOutcome[] = [];
  for (const candidate of orderCandidates(candidates)) {
    const outcome = await attempt(candidate, deps, timeoutMs);
    outcomes.push(outcome);
    if (outcome.ok) break;
  }
  return outcomes;
}

export async function discoverTransport(
  params: { domain: string; manualUri?: string },
  deps: ProbeDeps,
  settings: ProbeSettings = DEFAULT_PROBE_SETTINGS
): Promise<{ candidate: TransportCandidate; outcomes: readonly ProbeOutcome[] }> {
  const srvRecords = await collectSrv(params.domain, deps);
  const candidates = buildCandidates({ ...params, srvRecords });
  const outcomes = await probeInOrder(candidates, deps, settings.timeoutMs);
  return { candidate: selectBestCandidate(outcomes), outcomes };
}

/* ------------------------------------------------------------------------ */
/* Real probes (I/O). Not unit-tested: they need real sockets.              */
/* ------------------------------------------------------------------------ */

interface Closable {
  destroy(): void;
}

function timeoutError(): Error {
  return Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
}

/** Runs `start`, settling with the elapsed ms; always releases the resource. */
function timed(
  timeoutMs: number,
  start: (done: () => void, fail: (error: Error) => void) => Closable
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const began = Date.now();
    const held: { resource?: Closable } = {};
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      held.resource?.destroy();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(timeoutError())), timeoutMs);
    held.resource = start(
      () => finish(() => resolve(Date.now() - began)),
      (error) => finish(() => reject(error))
    );
  });
}

const probeTcp = (c: TransportCandidate, timeoutMs: number): Promise<number> =>
  timed(timeoutMs, (done, fail) => {
    const socket = netConnect({ host: c.host, port: c.port }, done);
    socket.on('error', fail);
    return socket;
  });

const probeTls = (c: TransportCandidate, timeoutMs: number): Promise<number> =>
  timed(timeoutMs, (done, fail) => {
    const socket = tlsConnect({ host: c.host, port: c.port, servername: c.host }, done);
    socket.on('error', fail);
    return socket;
  });

/**
 * An OPTIONS ping used to decide whether a UDP endpoint speaks SIP.
 *
 * The `;rport` parameter (RFC 3581) is NOT optional here. Without it the server
 * must answer to the address in `sent-by`, which behind NAT is not an address
 * that reaches us, so the reply is lost and a perfectly healthy PBX looks dead.
 * Verified against a live Kamailio: identical requests differing only in
 * `;rport` give "SIP/2.0 200 Alive" and silence respectively.
 */
export function buildOptionsProbe(host: string, localPort: number, branch: string): string {
  return [
    `OPTIONS sip:${host} SIP/2.0`,
    `Via: SIP/2.0/UDP 0.0.0.0:${localPort};branch=${branch};rport`,
    'Max-Forwards: 70',
    `From: <sip:probe@opensip.invalid>;tag=${branch}`,
    `To: <sip:${host}>`,
    `Call-ID: ${branch}@opensip.invalid`,
    'CSeq: 1 OPTIONS',
    `User-Agent: ${PROBE_USER_AGENT}`,
    'Content-Length: 0',
    '',
    ''
  ].join('\r\n');
}

export const PROBE_USER_AGENT = USER_AGENT;

const probeBranch = (): string => `z9hG4bK${randomBytes(6).toString('hex')}`;

const probeUdp = (c: TransportCandidate, timeoutMs: number): Promise<number> =>
  timed(timeoutMs, (done, fail) => {
    const socket = createSocket('udp4');
    const handle = { destroy: (): void => void socket.close() };
    socket.on('message', done);
    socket.on('error', fail);
    socket.bind(() => {
      const probe = buildOptionsProbe(c.host, socket.address().port, probeBranch());
      socket.send(probe, c.port, c.host, (error) => {
        if (error) fail(error);
      });
    });
    return handle;
  });

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEAD_END = '\r\n\r\n';

export const expectedAccept = (key: string): string =>
  createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');

export function buildUpgradeRequest(host: string, port: number, key: string): string {
  return [
    `GET / HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Protocol: sip',
    '',
    ''
  ].join('\r\n');
}

function headerMap(lines: readonly string[]): ReadonlyMap<string, string> {
  const pairs = lines.map((line): readonly [string, string] => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  });
  return new Map(pairs);
}

/** True only for a genuine RFC 6455/7118 handshake: 101, matching accept, `sip` subprotocol. */
export function isSipUpgrade(response: string, key: string): boolean {
  const [status = '', ...lines] = (response.split(HEAD_END)[0] ?? '').split('\r\n');
  if (!/^HTTP\/1\.1 101(?: |$)/.test(status)) return false;
  const headers = headerMap(lines);
  return (
    headers.get('sec-websocket-accept') === expectedAccept(key) &&
    headers.get('sec-websocket-protocol')?.toLowerCase() === 'sip'
  );
}

const notSipWebSocket = (): Error =>
  Object.assign(new Error('not-a-sip-websocket'), { code: 'ECONNREFUSED' });

function awaitUpgrade(socket: Socket, key: string, done: () => void, fail: (e: Error) => void): void {
  const state = { text: '' };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    state.text += chunk;
    if (!state.text.includes(HEAD_END)) return;
    if (isSipUpgrade(state.text, key)) done();
    else fail(notSipWebSocket());
  });
  socket.on('error', fail);
  socket.on('close', () => fail(notSipWebSocket()));
}

/** A bare TCP connect is NOT success: a stray web server on :80 must not look like SIP. */
const probeWebSocket = (c: TransportCandidate, timeoutMs: number): Promise<number> =>
  timed(timeoutMs, (done, fail) => {
    const key = randomBytes(16).toString('base64');
    const request = buildUpgradeRequest(c.host, c.port, key);
    const onReady = (): void => void socket.write(request);
    const socket =
      c.transport === 'wss'
        ? tlsConnect({ host: c.host, port: c.port, servername: c.host }, onReady)
        : netConnect({ host: c.host, port: c.port }, onReady);
    awaitUpgrade(socket, key, done, fail);
    return socket;
  });

const REAL_PROBES: Readonly<Record<TransportCandidate['transport'], typeof probeTcp>> = {
  tcp: probeTcp,
  tls: probeTls,
  udp: probeUdp,
  ws: probeWebSocket,
  wss: probeWebSocket
};

export function createProbeDeps(): ProbeDeps {
  return {
    resolveSrv: (name) => dnsResolveSrv(name),
    probe: (candidate, timeoutMs) => REAL_PROBES[candidate.transport](candidate, timeoutMs),
    now: () => Date.now()
  };
}
