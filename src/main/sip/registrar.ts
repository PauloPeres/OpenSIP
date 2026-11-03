import {
  buildAuthorization,
  headerValue,
  headerValues,
  isResponse,
  parseChallenge,
  parseParameters,
  withHeader
} from '@core/sip';
import type {
  SipAccount,
  SipHeaders,
  SipRequest,
  SipResponse,
  TransportCandidate
} from '@core/sip';
import type { SipConnection } from './connection';
import type { IdFactory } from './ids';

export interface RegistrarDeps {
  readonly connection: SipConnection;
  readonly ids: IdFactory;
  readonly hash: (s: string) => string;
  /** How long to wait for a final response; defaults to 10 s. */
  readonly timeoutMs?: number;
}

export interface RegisterParams {
  readonly account: SipAccount;
  readonly candidate: TransportCandidate;
  readonly expires: number;
  /** Our socket's own address (Via sent-by); defaults to the connection's local address. */
  readonly localAddress?: { readonly host: string; readonly port: number };
  /** NAT-mapped address the PBX sees (Contact); preferred over localAddress when known. */
  readonly publicAddress?: { readonly host: string; readonly port: number };
  /** Kept stable across the authenticated retry (RFC 3261 10.2). */
  readonly callId?: string;
  readonly fromTag?: string;
}

export type RegisterResult =
  | { ok: true; expiresIn: number }
  | { ok: false; status: number; errorKey: string };

type AuthHeaderName = 'authorization' | 'proxy-authorization';

export const USER_AGENT = 'OpenSIP/0.1.0';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS';
const DEFAULT_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT = 408;

/** RFC 3261 timers for unreliable transports. */
export const TIMER_T1_MS = 500;
export const UDP_MAX_TRANSMISSIONS = 7;
export const UDP_TRANSACTION_TIMEOUT_MS = 64 * TIMER_T1_MS;

const ERROR_KEYS = {
  forbidden: 'registration.error.forbidden',
  notFound: 'registration.error.notFound',
  timeout: 'registration.error.timeout',
  rejected: 'registration.error.rejected'
} as const;

const STATUS_ERROR_KEYS: Readonly<Record<number, string>> = {
  403: ERROR_KEYS.forbidden,
  404: ERROR_KEYS.notFound,
  408: ERROR_KEYS.timeout
};

function registerHeaders(params: RegisterParams, ids: IdFactory, cseq: number): SipHeaders {
  const { account, candidate, expires } = params;
  const local = params.localAddress ?? { host: candidate.host, port: candidate.port };
  const seen = params.publicAddress ?? local;
  return {
    via: [`SIP/2.0/${candidate.transport.toUpperCase()} ${local.host}:${local.port};branch=${ids.newBranch()};rport`],
    'max-forwards': ['70'],
    from: [`<${account.uri}>;tag=${params.fromTag ?? ids.newTag()}`],
    to: [`<${account.uri}>`],
    'call-id': [params.callId ?? ids.newCallId(local.host)],
    cseq: [`${cseq} REGISTER`],
    contact: [`<sip:${account.username}@${seen.host}:${seen.port};transport=${candidate.transport}>`],
    expires: [String(expires)],
    'user-agent': [USER_AGENT],
    allow: [ALLOW]
  };
}

export function buildRegisterRequest(
  params: RegisterParams,
  ids: IdFactory,
  cseq: number,
  authorization?: string,
  authHeader: AuthHeaderName = 'authorization'
): SipRequest {
  const base = registerHeaders(params, ids, cseq);
  const headers = authorization === undefined ? base : withHeader(base, authHeader, authorization);
  const { account } = params;
  return { kind: 'request', method: 'REGISTER', uri: `sip:${account.domain}`, headers, body: '' };
}

/* ---------------------------------------------------------------- waiting */

interface Waiter {
  readonly response: Promise<SipResponse | undefined>;
  readonly cancel: () => void;
}

const isFinalFor = (message: SipResponse, request: SipRequest): boolean =>
  message.status >= 200 &&
  headerValue(message.headers, 'call-id') === headerValue(request.headers, 'call-id') &&
  headerValue(message.headers, 'cseq') === headerValue(request.headers, 'cseq');

/** Resends on timer A: T1, then doubling, up to UDP_MAX_TRANSMISSIONS sends in all. */
function startRetransmit(resend: () => void): () => void {
  const state = { sent: 1, delay: TIMER_T1_MS, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  const tick = (): void => {
    resend();
    state.sent += 1;
    state.delay *= 2;
    if (state.sent < UDP_MAX_TRANSMISSIONS) state.timer = setTimeout(tick, state.delay);
  };
  state.timer = setTimeout(tick, state.delay);
  return () => clearTimeout(state.timer);
}

function awaitFinal(deps: RegistrarDeps, request: SipRequest, resend?: () => void): Waiter {
  let cancel = (): void => undefined;
  const response = new Promise<SipResponse | undefined>((resolve) => {
    const stop = deps.connection.onMessage((message) => {
      if (isResponse(message) && isFinalFor(message, request)) settle(message);
    });
    const stopResend = resend === undefined ? (): void => undefined : startRetransmit(resend);
    const limit = deps.timeoutMs ?? (resend === undefined ? DEFAULT_TIMEOUT_MS : UDP_TRANSACTION_TIMEOUT_MS);
    const timer = setTimeout(() => settle(undefined), limit);
    function settle(value: SipResponse | undefined): void {
      clearTimeout(timer);
      stopResend();
      stop();
      resolve(value);
    }
    cancel = (): void => settle(undefined);
  });
  return { response, cancel };
}

/** Learns the NAT-mapped address from the top Via of a response (RFC 3581). */
function learnPublicAddress(connection: SipConnection, response: SipResponse): void {
  const via = headerValues(response.headers, 'via')[0];
  if (via === undefined) return;
  const { received, rport } = parseParameters(via);
  if (received === undefined || received === '') return;
  const port = Number.parseInt(rport ?? '', 10);
  connection.publicAddress = { host: received, port: Number.isNaN(port) ? connection.localAddress.port : port };
}

async function exchange(
  deps: RegistrarDeps,
  request: SipRequest
): Promise<SipResponse | undefined> {
  const send = (): Promise<void> => deps.connection.send(request);
  const datagram = deps.connection.candidate.transport === 'udp';
  const waiter = awaitFinal(deps, request, datagram ? (): void => void send().catch(() => undefined) : undefined);
  try {
    await send();
  } catch {
    waiter.cancel();
  }
  const response = await waiter.response;
  if (response !== undefined) learnPublicAddress(deps.connection, response);
  return response;
}

/* ------------------------------------------------------------ interpreting */

function grantedExpiry(response: SipResponse, requested: number): number {
  const header = Number.parseInt(headerValue(response.headers, 'expires') ?? '', 10);
  if (!Number.isNaN(header)) return header;
  const contacts = headerValues(response.headers, 'contact');
  const fromContact = contacts
    .map((contact) => Number.parseInt(parseParameters(contact)['expires'] ?? '', 10))
    .find((value) => !Number.isNaN(value));
  return fromContact ?? requested;
}

function toResult(response: SipResponse | undefined, requested: number): RegisterResult {
  if (response === undefined) {
    return { ok: false, status: STATUS_TIMEOUT, errorKey: ERROR_KEYS.timeout };
  }
  if (response.status === 200) return { ok: true, expiresIn: grantedExpiry(response, requested) };
  const errorKey = STATUS_ERROR_KEYS[response.status] ?? ERROR_KEYS.rejected;
  return { ok: false, status: response.status, errorKey };
}

const isChallenge = (response: SipResponse | undefined): response is SipResponse =>
  response !== undefined && (response.status === 401 || response.status === 407);

interface Credentials {
  readonly value: string;
  readonly header: AuthHeaderName;
}

function digestFor(raw: string, params: RegisterParams, deps: RegistrarDeps): string | undefined {
  try {
    return buildAuthorization({
      challenge: parseChallenge(raw),
      username: params.account.username,
      password: params.account.password,
      method: 'REGISTER',
      digestUri: `sip:${params.account.domain}`,
      nonceCount: 1,
      cnonce: deps.ids.newCnonce(),
      hash: deps.hash
    });
  } catch {
    return undefined;
  }
}

function credentialsFor(
  response: SipResponse,
  params: RegisterParams,
  deps: RegistrarDeps
): Credentials | undefined {
  const proxy = response.status === 407;
  const raw = headerValue(response.headers, proxy ? 'proxy-authenticate' : 'www-authenticate');
  const value = raw === undefined ? undefined : digestFor(raw, params, deps);
  if (value === undefined) return undefined;
  return { value, header: proxy ? 'proxy-authorization' : 'authorization' };
}

/* ----------------------------------------------------------------- public */

async function authenticate(
  first: SipResponse,
  params: RegisterParams,
  deps: RegistrarDeps
): Promise<RegisterResult> {
  const credentials = credentialsFor(first, params, deps);
  if (credentials === undefined) return toResult(first, params.expires);
  const retry = buildRegisterRequest(withAddresses(params, deps), deps.ids, 2, credentials.value, credentials.header);
  return toResult(await exchange(deps, retry), params.expires);
}

/** Evaluated per request so an address learned from the first response is used by the next. */
function withAddresses(params: RegisterParams, deps: RegistrarDeps): RegisterParams {
  const { connection } = deps;
  const publicAddress = params.publicAddress ?? connection.publicAddress;
  return {
    ...params,
    localAddress: params.localAddress ?? connection.localAddress,
    ...(publicAddress === undefined ? {} : { publicAddress })
  };
}

export async function register(params: RegisterParams, deps: RegistrarDeps): Promise<RegisterResult> {
  const local = params.localAddress ?? deps.connection.localAddress;
  const stable: RegisterParams = {
    ...params,
    localAddress: local,
    callId: params.callId ?? deps.ids.newCallId(local.host),
    fromTag: params.fromTag ?? deps.ids.newTag()
  };
  const first = await exchange(deps, buildRegisterRequest(withAddresses(stable, deps), deps.ids, 1));
  if (isChallenge(first)) return authenticate(first, stable, deps);
  return toResult(first, params.expires);
}
