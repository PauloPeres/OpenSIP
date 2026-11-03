import {
  analyseBindings,
  buildAuthorization,
  headerValue,
  headerValues,
  isResponse,
  otherBindings,
  parseChallenge,
  parseParameters,
  withHeader
} from '@core/sip';
import type {
  BindingAnalysis,
  BindingOwner,
  DigestChallenge,
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

export interface AcceptedRegistration {
  ok: true;
  expiresIn: number;
  /** What the 200 OK's Contact list says about other devices holding this account. */
  sharing: BindingAnalysis;
  /** Normalised URIs of the other live bindings, for the diagnostics log. */
  otherContacts: readonly string[];
}

export type RegisterResult =
  | AcceptedRegistration
  | { ok: false; status: number; errorKey: string };

type AuthHeaderName = 'authorization' | 'proxy-authorization';

export const MAX_AUTH_ATTEMPTS = 3;
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
  rejected: 'registration.error.rejected',
  unauthorized: 'registration.error.unauthorized'
} as const;

const STATUS_ERROR_KEYS: Readonly<Record<number, string>> = {
  403: ERROR_KEYS.forbidden,
  404: ERROR_KEYS.notFound,
  408: ERROR_KEYS.timeout
};

function localAddressOf(params: RegisterParams): { host: string; port: number } {
  return params.localAddress ?? { host: params.candidate.host, port: params.candidate.port };
}

/** The address our Contact advertises: the NAT-mapped one when known. */
export function contactOwner(params: RegisterParams): BindingOwner {
  const { host, port } = params.publicAddress ?? localAddressOf(params);
  return { host, port, user: params.account.username };
}

function registerHeaders(params: RegisterParams, ids: IdFactory, cseq: number): SipHeaders {
  const { account, candidate, expires } = params;
  const local = localAddressOf(params);
  const seen = contactOwner(params);
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

function accepted(response: SipResponse, requested: number, owner: BindingOwner): RegisterResult {
  const contacts = headerValues(response.headers, 'contact');
  return {
    ok: true,
    expiresIn: grantedExpiry(response, requested),
    sharing: analyseBindings(contacts, owner),
    otherContacts: otherBindings(contacts, owner).map((binding) => binding.uri)
  };
}

/** `sent` is who the request we are answering claimed to be, so the Contact list is read against it. */
function toResult(response: SipResponse | undefined, requested: number, sent: BindingOwner): RegisterResult {
  if (response === undefined) {
    return { ok: false, status: STATUS_TIMEOUT, errorKey: ERROR_KEYS.timeout };
  }
  if (response.status === 200) return accepted(response, requested, sent);
  const errorKey = STATUS_ERROR_KEYS[response.status] ?? ERROR_KEYS.rejected;
  return { ok: false, status: response.status, errorKey };
}

const isChallenge = (response: SipResponse | undefined): response is SipResponse =>
  response !== undefined && (response.status === 401 || response.status === 407);

interface Credentials {
  readonly value: string;
  readonly header: AuthHeaderName;
  readonly nonce: string;
  readonly stale: boolean;
}

function challengeOf(response: SipResponse): { raw: string | undefined; proxy: boolean } {
  const proxy = response.status === 407;
  return { raw: headerValue(response.headers, proxy ? 'proxy-authenticate' : 'www-authenticate'), proxy };
}

function digestFor(challenge: DigestChallenge, params: RegisterParams, deps: RegistrarDeps): string {
  return buildAuthorization({
    challenge,
    username: params.account.username,
    password: params.account.password,
    method: 'REGISTER',
    digestUri: `sip:${params.account.domain}`,
    nonceCount: 1,
    cnonce: deps.ids.newCnonce(),
    hash: deps.hash
  });
}

function credentialsFor(
  response: SipResponse,
  params: RegisterParams,
  deps: RegistrarDeps
): Credentials | undefined {
  const { raw, proxy } = challengeOf(response);
  if (raw === undefined) return undefined;
  try {
    const challenge = parseChallenge(raw);
    const header = proxy ? 'proxy-authorization' : 'authorization';
    return { value: digestFor(challenge, params, deps), header, nonce: challenge.nonce, stale: challenge.stale };
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------------- public */

const unauthorized = (status: number): RegisterResult => ({
  ok: false,
  status,
  errorKey: ERROR_KEYS.unauthorized
});

/**
 * Answers each fresh challenge (RFC 3261 22 / RFC 2617): a repeated nonce means
 * the credentials are wrong, a new or stale one is worth another try.
 */
async function authenticate(
  first: SipResponse,
  params: RegisterParams,
  deps: RegistrarDeps
): Promise<RegisterResult> {
  let challenge = first;
  let usedNonce: string | undefined;
  for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt += 1) {
    const credentials = credentialsFor(challenge, params, deps);
    if (credentials === undefined) return toResult(challenge, params.expires, contactOwner(params));
    if (credentials.nonce === usedNonce && !credentials.stale) return unauthorized(challenge.status);
    const sent = withAddresses(params, deps);
    const response = await exchange(deps, authenticatedRequest(sent, deps, attempt + 1, credentials));
    if (!isChallenge(response)) return toResult(response, params.expires, contactOwner(sent));
    challenge = response;
    usedNonce = credentials.nonce;
  }
  return unauthorized(challenge.status);
}

function authenticatedRequest(
  sent: RegisterParams,
  deps: RegistrarDeps,
  cseq: number,
  credentials: Credentials
): SipRequest {
  return buildRegisterRequest(sent, deps.ids, cseq, credentials.value, credentials.header);
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
  const sent = withAddresses(stable, deps);
  const first = await exchange(deps, buildRegisterRequest(sent, deps.ids, 1));
  if (isChallenge(first)) return authenticate(first, stable, deps);
  return toResult(first, params.expires, contactOwner(sent));
}
