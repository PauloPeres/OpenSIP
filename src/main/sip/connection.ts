import { createSocket } from 'node:dgram';
import type { RemoteInfo, Socket as DgramSocket } from 'node:dgram';
import { connect as netConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { redactSipMessage } from '@core/diagnostics';
import { extractMessages, parse, serialize } from '@core/sip';
import type { SipMessage, SipTransport, TransportCandidate } from '@core/sip';
import { log } from '../windows';

export interface SipConnection {
  send(message: SipMessage): Promise<void>;
  onMessage(listener: (message: SipMessage) => void): () => void;
  /**
   * Fires for EVERY inbound datagram or stream chunk, before it is parsed: a CRLF ping, a partial message and
   * a datagram that fails to parse are all packets, and liveness is about packets, not well-formed SIP.
   */
  onActivity(listener: () => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  /**
   * Sends the RFC 5626 CRLF ping (`\r\n\r\n`) and nothing else. Rejects with `keepalive-unsupported` over
   * WebSocket, where the keepalive is protocol-level and the caller sends a request instead.
   */
  sendKeepalive(): Promise<void>;
  close(): void;
  readonly candidate: TransportCandidate;
  readonly localAddress: { host: string; port: number };
  /** NAT-mapped address learned from `received`/`rport` on a response's top Via (RFC 3581). */
  publicAddress?: { host: string; port: number };
}

export interface WebSocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** A diagnostic the connection wants recorded; `params` are already redacted, so the receiver may store them as is. */
export interface ConnectionNotice {
  readonly level: 'debug';
  readonly messageKey: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface ConnectionDeps {
  /** Receives diagnostics about traffic the connection discards. Optional: the connection never depends on it. */
  readonly onNotice?: (notice: ConnectionNotice) => void;
  readonly connectTimeoutMs?: number;
  /** Defaults to the runtime's global WebSocket, which Electron 33 (Node 20) does not provide. */
  readonly webSocket?: (new (url: string, protocols?: string | string[]) => WebSocketLike) | undefined;
}

/** A peer that never completes a message must not grow memory without bound. */
export const MAX_BUFFER_BYTES = 64 * 1024;
/**
 * A hostile or broken peer could send thousands of bad datagrams a second, so unparsable ones are reported at
 * most once per interval per connection (the first at once, later ones as a count). No timer is involved: the
 * window is checked when the next bad datagram arrives, so an idle connection costs nothing.
 */
export const MALFORMED_REPORT_INTERVAL_MS = 10_000;
/** Enough to recognise the start-line and first headers, little enough to keep the log readable. */
const MALFORMED_PREFIX_CHARS = 120;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const WS_LOCAL: { host: string; port: number } = { host: 'opensip.invalid', port: 5060 };

interface Hub {
  readonly emit: (message: SipMessage) => void;
  readonly touch: () => void;
  readonly onActivity: SipConnection['onActivity'];
  readonly end: (reason: string) => void;
  readonly onMessage: SipConnection['onMessage'];
  readonly onClose: SipConnection['onClose'];
}

function subscribers<T>(): { readonly add: (listener: T) => () => void; readonly each: (call: (listener: T) => void) => void } {
  const set = new Set<T>();
  return {
    add: (listener) => {
      set.add(listener);
      return () => set.delete(listener);
    },
    each: (call) => set.forEach(call)
  };
}

function createHub(): Hub {
  const messages = subscribers<(message: SipMessage) => void>();
  const closers = subscribers<(reason: string) => void>();
  const activity = subscribers<() => void>();
  const state = { ended: false };
  return {
    emit: (message) => messages.each((listener) => listener(message)),
    touch: () => activity.each((listener) => listener()),
    onActivity: activity.add,
    end: (reason): void => {
      if (state.ended) return;
      state.ended = true;
      closers.each((listener) => listener(reason));
    },
    onMessage: messages.add,
    onClose: closers.add
  };
}

/** RFC 5626 section 3.5.1 / 4.4.1: a double CRLF is the ping, a single CRLF its answer. */
const PING = '\r\n\r\n';
const PONG = '\r\n';

interface Io {
  readonly write: (text: string) => Promise<void>;
  readonly destroy: () => void;
  /** False where a CRLF keepalive is not valid (WebSocket). */
  readonly keepalive: boolean;
}

const unsupported = (): Promise<void> => Promise.reject(new Error('keepalive-unsupported'));

function assemble(
  candidate: TransportCandidate,
  localAddress: SipConnection['localAddress'],
  hub: Hub,
  io: Io
): SipConnection {
  return {
    candidate,
    localAddress,
    onMessage: hub.onMessage,
    onClose: hub.onClose,
    onActivity: hub.onActivity,
    send: (message) => io.write(serialize(message)),
    sendKeepalive: () => (io.keepalive ? io.write(PING) : unsupported()),
    close: (): void => {
      io.destroy();
      hub.end('closed');
    }
  };
}

function ingest(buffer: string, hub: Hub, socket: Socket): string {
  try {
    const { messages, rest } = extractMessages(buffer);
    messages.forEach(hub.emit);
    if (rest.length <= MAX_BUFFER_BYTES) return rest;
    hub.end('buffer-overflow');
  } catch {
    hub.end('malformed-message');
  }
  socket.destroy();
  return '';
}

const reasonOf = (error: Error): string => (error as { code?: string }).code ?? error.message;

function wireStream(candidate: TransportCandidate, socket: Socket): SipConnection {
  const hub = createHub();
  const state = { buffer: '' };
  const write = (text: string): Promise<void> =>
    new Promise((resolve, reject) => socket.write(text, (error) => (error ? reject(error) : resolve())));
  const pong = (): void => void write(PONG).catch(() => undefined);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    hub.touch();
    if (state.buffer === '' && isPing(chunk)) pong();
    state.buffer = ingest(state.buffer + chunk, hub, socket);
  });
  socket.on('error', (error) => hub.end(reasonOf(error)));
  socket.on('close', () => hub.end('closed'));
  const local = { host: socket.localAddress ?? '0.0.0.0', port: socket.localPort ?? 0 };
  return assemble(candidate, local, hub, { write, destroy: () => socket.destroy(), keepalive: true });
}

function whenReady(socket: Socket, readyEvent: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', reject);
    socket.once(readyEvent, () => {
      socket.setTimeout(0);
      socket.removeListener('error', reject);
      resolve();
    });
  });
}

async function openStream(
  candidate: TransportCandidate,
  deps: ConnectionDeps
): Promise<SipConnection> {
  const { host, port } = candidate;
  const secure = candidate.transport === 'tls';
  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  await whenReady(socket, secure ? 'secureConnect' : 'connect', deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  return wireStream(candidate, socket);
}

/** Only CR/LF: an RFC 5626 keepalive ping (`\r\n\r\n`) or its pong (`\r\n`). It is not a message, nor an error. */
const isKeepalive = (text: string): boolean => /^[\r\n]+$/.test(text);

/** A ping is a keepalive of at least a double CRLF; a lone CRLF is the pong, which is never answered. */
const isPing = (text: string): boolean => text.length >= PING.length && isKeepalive(text);

/** Redacts first, then trims and makes control bytes visible, so no secret survives the cut. */
function safePrefix(text: string): string {
  return redactSipMessage(text)
    .slice(0, MALFORMED_PREFIX_CHARS)
    .replace(/[^\x20-\x7e]/g, (char) => (char === '\r' || char === '\n' ? ' ' : '.'));
}

type Reporter = (text: string, bytes: number, source: string) => void;

function createMalformedReporter(onNotice: ConnectionDeps['onNotice']): Reporter {
  const state = { last: Number.NEGATIVE_INFINITY, skipped: 0 };
  return (text, bytes, source) => {
    const now = Date.now();
    if (onNotice === undefined || now - state.last < MALFORMED_REPORT_INTERVAL_MS) {
      state.skipped += 1;
      return;
    }
    const params = { source, bytes: String(bytes), skipped: String(state.skipped), prefix: safePrefix(text) };
    state.last = now;
    state.skipped = 0;
    onNotice({ level: 'debug', messageKey: 'logs.event.datagramDropped', params });
  };
}

function parseDatagram(data: Buffer, hub: Hub, report: Reporter, source: string, pong?: () => void): void {
  hub.touch();
  const text = data.toString('utf8');
  if (isKeepalive(text)) return void (isPing(text) && pong?.());
  try {
    hub.emit(parse(text));
  } catch {
    report(text, data.length, source);
  }
}

/** Notes, once per distinct source, a datagram that did not come from the server we sent to. */
function noteForeignSource(candidate: TransportCandidate, seen: Set<string>): (info: RemoteInfo) => void {
  return (info) => {
    const source = `${info.address}:${info.port}`;
    if (source === `${candidate.host}:${candidate.port}` || seen.has(source)) return;
    seen.add(source);
    log('info', `udp datagram from ${source}, not the server ${candidate.host}:${candidate.port}`);
  };
}

const UNSPECIFIED = '0.0.0.0';

/** First non-loopback IPv4 of this machine; loopback only when there is none. A Via must never say 0.0.0.0. */
function fallbackAddress(): string {
  const all = Object.values(networkInterfaces()).flatMap((list) => list ?? []);
  return all.find((item) => item.family === 'IPv4' && !item.internal)?.address ?? '127.0.0.1';
}

/**
 * Asks the kernel which local address routes to the server. A connected UDP socket sends nothing, it only
 * selects a route, so this probe is closed at once; the real socket stays unconnected (see openDatagram).
 */
function egressAddress(candidate: TransportCandidate): Promise<string> {
  return new Promise((resolve) => {
    const probe = createSocket('udp4');
    const finish = (address: string | undefined): void => {
      probe.close();
      resolve(address === undefined || address === UNSPECIFIED ? fallbackAddress() : address);
    };
    probe.once('error', () => finish(undefined));
    probe.connect(candidate.port, candidate.host, () => finish(probe.address().address));
  });
}

function bindDatagram(socket: DgramSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('listening', resolve);
    socket.bind(0);
  });
}

function datagramWriter(socket: DgramSocket, candidate: TransportCandidate): Io['write'] {
  return (text) =>
    new Promise((resolve, reject) =>
      socket.send(text, candidate.port, candidate.host, (error) => (error ? reject(error) : resolve()))
    );
}

/**
 * The socket is deliberately NOT connect()ed. A connected UDP socket makes the kernel drop every datagram
 * whose source differs from the connected peer, but a SIP proxy routinely answers from another port,
 * listener or interface (and a relayed call from another element entirely), so the 180/200 that follow a
 * 100 Trying would vanish. RFC 3261 matches responses by Via branch / Call-ID / CSeq, never by source,
 * so we bind, send with an explicit destination and accept datagrams from anywhere.
 */
async function openDatagram(candidate: TransportCandidate, deps: ConnectionDeps): Promise<SipConnection> {
  const address = await egressAddress(candidate);
  const socket = createSocket('udp4');
  const hub = createHub();
  const noteSource = noteForeignSource(candidate, new Set());
  const report = createMalformedReporter(deps.onNotice);
  const write = datagramWriter(socket, candidate);
  const pong = (): void => void write(PONG).catch(() => undefined);
  socket.on('message', (data, info) => {
    noteSource(info);
    parseDatagram(data, hub, report, `${info.address}:${info.port}`, pong);
  });
  socket.on('error', (error) => hub.end(reasonOf(error)));
  socket.on('close', () => hub.end('closed'));
  await bindDatagram(socket);
  const { port } = socket.address();
  return assemble(candidate, { host: address, port }, hub, { write, destroy: () => socket.close(), keepalive: true });
}

function wireWebSocket(candidate: TransportCandidate, socket: WebSocketLike, deps: ConnectionDeps): SipConnection {
  const hub = createHub();
  const report = createMalformedReporter(deps.onNotice);
  const source = `${candidate.host}:${candidate.port}`;
  socket.onmessage = (event): void => {
    if (typeof event.data === 'string') parseDatagram(Buffer.from(event.data), hub, report, source);
    else hub.touch();
  };
  socket.onclose = (): void => hub.end('closed');
  socket.onerror = (): void => hub.end('websocket-error');
  const write = async (text: string): Promise<void> => socket.send(text);
  return assemble(candidate, WS_LOCAL, hub, { write, destroy: () => socket.close(), keepalive: false });
}

function openWebSocket(candidate: TransportCandidate, deps: ConnectionDeps): Promise<SipConnection> {
  const Ctor = deps.webSocket ?? (globalThis as { WebSocket?: ConnectionDeps['webSocket'] }).WebSocket;
  if (Ctor === undefined) return Promise.reject(new Error('websocket-unavailable'));
  const scheme = candidate.transport === 'wss' ? 'wss' : 'ws';
  const socket = new Ctor(`${scheme}://${candidate.host}:${candidate.port}`, 'sip');
  return new Promise((resolve, reject) => {
    socket.onerror = (): void => reject(new Error('websocket-error'));
    socket.onopen = (): void => resolve(wireWebSocket(candidate, socket, deps));
  });
}

type Opener = (candidate: TransportCandidate, deps: ConnectionDeps) => Promise<SipConnection>;

const OPENERS: Readonly<Record<SipTransport, Opener>> = {
  tcp: openStream,
  tls: openStream,
  udp: openDatagram,
  ws: openWebSocket,
  wss: openWebSocket
};

export function openConnection(
  candidate: TransportCandidate,
  deps: ConnectionDeps = {}
): Promise<SipConnection> {
  return OPENERS[candidate.transport](candidate, deps);
}
