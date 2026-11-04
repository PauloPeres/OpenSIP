import {
  analyseBindings,
  buildAuthorization,
  headerValue,
  headerValues,
  isOurBinding,
  isResponse,
  otherBindings,
  parseContactBindings,
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
import { USER_AGENT } from './user-agent';

export { USER_AGENT };

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
  | {
      ok: false;
      status: number;
      errorKey: string;
      /** Seconds from the response's Retry-After, when it had a numeric one. */
      retryAfter?: number;
      /** Seconds from the response's Min-Expires (423), when it had a numeric one. */
      minExpires?: number;
    };

type AuthHeaderName = 'authorization' | 'proxy-authorization';

export const MAX_AUTH_ATTEMPTS = 3;
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

/** A bare OPTIONS to the server: any answer, even an error, proves the path works and refreshes the NAT binding. */
export function buildOptionsRequest(params: RegisterParams, ids: IdFactory, cseq: number): SipRequest {
  const { account, candidate } = params;
  const local = localAddressOf(params);
  const headers: SipHeaders = {
    via: [`SIP/2.0/${candidate.transport.toUpperCase()} ${local.host}:${local.port};branch=${ids.newBranch()};rport`],
    'max-forwards': ['70'],
    from: [`<${account.uri}>;tag=${ids.newTag()}`],
    to: [`<sip:${account.domain}>`],
    'call-id': [ids.newCallId(local.host)],
    cseq: [`${cseq} OPTIONS`],
    'user-agent': [USER_AGENT]
  };
  return { kind: 'request', method: 'OPTIONS', uri: `sip:${account.domain}`, headers, body: '' };
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

/**
 * Learns the NAT-mapped address from the top Via of ANY response on the connection (RFC 3581): the server
 * reports what it sees whether the response answers a REGISTER, an OPTIONS ping or an INVITE. Returns whether
 * the mapping is new or differs from the one held, so a caller can react to a move.
 */
export function learnPublicAddress(connection: SipConnection, response: SipResponse): boolean {
  const via = headerValues(response.headers, 'via')[0];
  if (via === undefined) return false;
  const { received, rport } = parseParameters(via);
  if (received === undefined || received === '') return false;
  const port = Number.parseInt(rport ?? '', 10);
  const learned = { host: received, port: Number.isNaN(port) ? connection.localAddress.port : port };
  const known = connection.publicAddress;
  connection.publicAddress = learned;
  return known?.host !== learned.host || known.port !== learned.port;
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

const leadingSeconds = (value: string | undefined): number | undefined => {
  const digits = /^\s*(\d+)/.exec(value ?? '')?.[1];
  return digits === undefined ? undefined : Number(digits);
};

/**
 * What the registrar granted US. The Contact list holds every device bound to the account, so only the
 * contact that is ours (RFC 3261 10.2.4: its own expires parameter beats the Expires header) may be read;
 * the first contact in the list is as likely to be someone else's.
 */
function grantedExpiry(response: SipResponse, requested: number, owner: BindingOwner): number {
  const ours = parseContactBindings(headerValues(response.headers, 'contact')).find((binding) => isOurBinding(binding, owner));
  const header = Number.parseInt(headerValue(response.headers, 'expires') ?? '', 10);
  return ours?.expires ?? (Number.isNaN(header) ? requested : header);
}

function accepted(response: SipResponse, requested: number, owner: BindingOwner): RegisterResult {
  const contacts = headerValues(response.headers, 'contact');
  return {
    ok: true,
    expiresIn: grantedExpiry(response, requested, owner),
    sharing: analyseBindings(contacts, owner),
    otherContacts: otherBindings(contacts, owner).map((binding) => binding.uri)
  };
}

/** Retry-After and Min-Expires, each only when numeric, for the retry policy. */
function retryHints(response: SipResponse): { retryAfter?: number; minExpires?: number } {
  const retryAfter = leadingSeconds(headerValue(response.headers, 'retry-after'));
  const minExpires = leadingSeconds(headerValue(response.headers, 'min-expires'));
  return {
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(minExpires === undefined ? {} : { minExpires })
  };
}

/** `sent` is who the request we are answering claimed to be, so the Contact list is read against it. */
function toResult(response: SipResponse | undefined, requested: number, sent: BindingOwner): RegisterResult {
  if (response === undefined) {
    return { ok: false, status: STATUS_TIMEOUT, errorKey: ERROR_KEYS.timeout };
  }
  if (response.status === 200) return accepted(response, requested, sent);
  const errorKey = STATUS_ERROR_KEYS[response.status] ?? ERROR_KEYS.rejected;
  return { ok: false, status: response.status, errorKey, ...retryHints(response) };
}

const isChallenge = (response: SipResponse | undefined): response is SipResponse =>
  response !== undefined && (response.status === 401 || response.status === 407);

export interface Credentials {
  readonly value: string;
  readonly header: AuthHeaderName;
  readonly nonce: string;
  readonly stale: boolean;
}

/** Who is signing which request: everything a digest answer needs besides the challenge itself. */
export interface DigestSubject {
  readonly username: string;
  readonly password: string;
  readonly method: string;
  readonly digestUri: string;
  readonly newCnonce: () => string;
  readonly hash: (s: string) => string;
}

function challengeOf(response: SipResponse): { raw: string | undefined; proxy: boolean } {
  const proxy = response.status === 407;
  return { raw: headerValue(response.headers, proxy ? 'proxy-authenticate' : 'www-authenticate'), proxy };
}

function digestFor(challenge: DigestChallenge, subject: DigestSubject): string {
  return buildAuthorization({
    challenge,
    username: subject.username,
    password: subject.password,
    method: subject.method,
    digestUri: subject.digestUri,
    nonceCount: 1,
    cnonce: subject.newCnonce(),
    hash: subject.hash
  });
}

/** Answers a 401/407 for any method; undefined when the challenge is missing, malformed or unsupported. */
export function credentialsFor(response: SipResponse, subject: DigestSubject): Credentials | undefined {
  const { raw, proxy } = challengeOf(response);
  if (raw === undefined) return undefined;
  try {
    const challenge = parseChallenge(raw);
    const header = proxy ? 'proxy-authorization' : 'authorization';
    return { value: digestFor(challenge, subject), header, nonce: challenge.nonce, stale: challenge.stale };
  } catch {
    return undefined;
  }
}

/** The same nonce back again, and not marked stale, means the credentials themselves are wrong. */
export const repeatsNonce = (credentials: Credentials, usedNonce: string | undefined): boolean =>
  credentials.nonce === usedNonce && !credentials.stale;

function registerSubject(params: RegisterParams, deps: RegistrarDeps): DigestSubject {
  const { username, password, domain } = params.account;
  return { username, password, method: 'REGISTER', digestUri: `sip:${domain}`, newCnonce: () => deps.ids.newCnonce(), hash: deps.hash };
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
    const credentials = credentialsFor(challenge, registerSubject(params, deps));
    if (credentials === undefined) return toResult(challenge, params.expires, contactOwner(params));
    if (repeatsNonce(credentials, usedNonce)) return unauthorized(challenge.status);
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
