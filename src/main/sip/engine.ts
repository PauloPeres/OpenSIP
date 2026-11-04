/*
 * Native SIP engine.
 *
 * Signalling and media: registration, inbound and outbound INVITE, BYE/CANCEL,
 * hold/resume re-INVITEs, and the RTP session and microphone/speaker streams
 * that carry the call's audio (see ../media).
 *
 * All registration and call state transitions go through the pure reducers in
 * `@core/sip`; this file only translates wire events into reducer events and
 * performs I/O. Invalid transitions are logged, never thrown at the user.
 * Everything worth showing the user goes to the diagnostics log as i18n keys.
 */
import { createHash } from 'node:crypto';
import { createDiagnosticsLog } from '@core/diagnostics';
import type { DiagnosticsLog, LogLevel } from '@core/diagnostics';
import { PCMA_PAYLOAD_TYPE, PCMU_PAYLOAD_TYPE } from '@core/rtp';
import {
  ConcurrentCallLimitError,
  InvalidCallTargetError,
  MalformedSdpError,
  NoCommonCodecError,
  TRANSPORT_ERROR_KEYS,
  applyCallEvent,
  buildOffer,
  callsForAccount,
  decideKeepalive,
  decideRetry,
  emptyCallRegistry,
  headerValue,
  headerValues,
  holdDirection,
  incomingCall,
  initialRegistration,
  isResponse,
  keepaliveMethod,
  keepalivePolicy,
  negotiate,
  noteInbound,
  noteMedia,
  noteSent,
  normaliseTarget,
  outgoingCall,
  parseSdp,
  parseUri,
  reduceRegistration,
  resumeDirection,
  serialize,
  startKeepalive as freshKeepalive,
  withHeader
} from '@core/sip';
import type { AccountSharing } from '../../shared/api';
import type {
  AccountId,
  CallEvent,
  CallRegistry,
  CallSession,
  KeepaliveState,
  RegistrationEvent,
  RegistrationFailure,
  RegistrationSnapshot,
  SdpDirection,
  SessionDescription,
  SipAccount,
  SipHeaders,
  SipMessage,
  SipRequest,
  SipResponse,
  TransportCandidate
} from '@core/sip';
import type { CallView, DialResult, DtmfDigit } from '../../shared/api';
import { SETUP_IN_PROGRESS_KEY, isOutboundInSetup } from '../../shared/api';
import { allocateRtpPort, createRtpSession } from '../media/rtp-session';
import type { RtpSession, RtpSessionOptions } from '../media/rtp-session';
import type { MediaBridge } from '../media/media-window';
import { log } from '../windows';
import { openConnection } from './connection';
import type { ConnectionDeps, SipConnection } from './connection';
import { defaultIdFactory } from './ids';
import type { IdFactory } from './ids';
import { createProbeDeps, discoverTransport } from './prober';
import type { ProbeDeps } from './prober';
import {
  MAX_AUTH_ATTEMPTS,
  TIMER_T1_MS,
  UDP_MAX_TRANSMISSIONS,
  UDP_TRANSACTION_TIMEOUT_MS,
  USER_AGENT,
  buildOptionsRequest,
  credentialsFor,
  learnPublicAddress,
  register,
  repeatsNonce
} from './registrar';
import type { AcceptedRegistration, Credentials, RegisterResult } from './registrar';

const REFRESH_FRACTION = 0.9;
const MIN_REFRESH_MS = 5_000;
/** How often the keepalive timer looks at the clocks; the policies in core/sip/keepalive.ts are multiples of it. */
const KEEPALIVE_TICK_MS = 5_000;
/** The error shown for a flow that stopped answering: the same wording as a REGISTER that timed out. */
const TRANSPORT_FAILURE: RegistrationFailure = { kind: 'transport' };
const DEAD_FLOW_KEY = 'registration.error.timeout';
const UNREGISTER_TIMEOUT_MS = 1_500;
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS';
const SUPPORTED_CODECS: readonly number[] = [PCMU_PAYLOAD_TYPE, PCMA_PAYLOAD_TYPE];
/** The i18n catalogue has one generic key for a call that did not complete, whatever the cause. */
const CALL_FAILED_KEY = 'calls.error.failed';

const PROGRESS_TRYING = 'calls.progress.trying';
const PROGRESS_RINGING = 'calls.progress.ringing';
const PROGRESS_WAITING = 'calls.progress.waiting';
const END_REASON_SETUP_TIMEOUT = 'calls.endReason.setupTimeout';

/**
 * How long an outbound call may take to be answered, counted from the moment
 * the INVITE is sent.
 *
 * RFC 3261 17.1.1 makes the first provisional response (even a bare 100) move
 * the INVITE client transaction to Proceeding and CANCEL timer B, so a UAC that
 * got a 100 is specified to wait for a final response indefinitely. A server
 * that never completes the call (a dialplan that swallows it) would leave the
 * user on a spinner forever, so, like real softphones, we apply our own guard.
 *
 * Do NOT "fix" this by restarting the timer on provisional responses: a stream
 * of 100s must not keep the call alive, and a far end that rings for the whole
 * period without answering is also a call the user should be released from, so
 * 180 and 183 deliberately leave the guard running too.
 */
export const CALL_SETUP_TIMEOUT_MS = 90_000;

/**
 * How long "Trying" may stay on screen after the first 100 before we say we are
 * waiting for the server. Post-dial delay on a healthy route (to the first 180
 * or 183) is normally one to three seconds and ITU-T E.721 treats a few seconds
 * as the acceptable ceiling, so 4 s leaves normal calls untouched, yet the user
 * hears from us long before the 90 s guard, rather than staring at a frozen label.
 */
export const CALL_WAITING_GRACE_MS = 4_000;

/** Provisional status -> progress key; a 2xx and media start are tracked where they happen. */
const PROGRESS_BY_STATUS: Readonly<Record<number, string>> = {
  100: PROGRESS_TRYING,
  180: PROGRESS_RINGING,
  183: PROGRESS_RINGING
};
const PROGRESS_CONNECTING = 'calls.progress.connecting';
const PROGRESS_ACTIVE = 'calls.progress.active';
const PROGRESS_ENDED = 'calls.progress.ended';
/** The same wording as a failed REGISTER: the PBX refused our credentials. */
const UNAUTHORIZED_KEY = 'registration.error.unauthorized';
const END_REASON_BY_STATUS: Readonly<Record<number, string>> = {
  401: UNAUTHORIZED_KEY,
  407: UNAUTHORIZED_KEY,
  403: 'registration.error.forbidden',
  486: 'calls.endReason.busy',
  600: 'calls.endReason.busy',
  603: 'calls.endReason.declined',
  408: 'calls.endReason.unanswered',
  480: 'calls.endReason.unanswered',
  404: 'calls.endReason.unreachable',
  484: 'calls.endReason.unreachable',
  604: 'calls.endReason.unreachable'
};
const STATUS_REQUEST_TIMEOUT = 408;
/** How long a call that ended with a reason stays in getCallViews(). */
export const ENDED_CALL_LINGER_MS = 8000;

/** What the user is told about one call, kept apart from the signalling state. */
interface CallTrack {
  progress?: string;
  endReasonKey?: string;
  /** Wall-clock ms when the end reason was recorded; the row lapses ENDED_CALL_LINGER_MS later. */
  endedAt?: number;
}

const md5 = (input: string): string => createHash('md5').update(input).digest('hex');

type Listener = () => void;
type Timer = ReturnType<typeof setTimeout>;
type Role = 'uac' | 'uas';

/** Creates and numbers the RTP port and session of one call. */
export interface RtpFactory {
  allocatePort(): Promise<number>;
  create(options: RtpSessionOptions): RtpSession;
}

export interface EngineDeps {
  readonly probe: ProbeDeps;
  readonly ids: IdFactory;
  readonly open: typeof openConnection;
  readonly diagnostics: DiagnosticsLog;
  readonly media: MediaBridge;
  readonly rtp: RtpFactory;
  readonly now: () => number;
  /** In [0, 1); injected so the jitter of the retry backoff is testable. */
  readonly random: () => number;
}

/** The ping timer of a registered flow and the two clocks the core reducer decides from. */
interface Keepalive {
  state: KeepaliveState;
  readonly timer: ReturnType<typeof setInterval>;
  cseq: number;
}

interface Entry {
  readonly account: SipAccount;
  snapshot: RegistrationSnapshot;
  candidate: TransportCandidate | undefined;
  connection: SipConnection | undefined;
  timer: Timer | undefined;
  stopped: boolean;
  /** What the last REGISTER 200 said about other devices, and its change-detection key. */
  sharing: AccountSharing | undefined;
  sharingKey: string | undefined;
  /** Failures in a row since the last success; drives the retry backoff. */
  failures: number;
  /** 423 answers in a row, so a server whose Min-Expires keeps climbing cannot loop us. */
  raises: number;
  /** An Expires the registrar insisted on (423 Min-Expires), kept for every later refresh. */
  expires: number | undefined;
  keepalive: Keepalive | undefined;
}

interface MediaPlan {
  readonly payloadType: number;
  readonly dtmfPayloadType: number | undefined;
  readonly host: string;
  readonly port: number;
}

interface LiveMedia {
  readonly session: RtpSession;
  readonly stopPlayback: () => void;
}

/** Our own limit on how long a call may stay unanswered; see CALL_SETUP_TIMEOUT_MS. */
interface SetupGuard {
  readonly expiry: Timer;
  waiting: Timer | undefined;
}

/** How many digest answers this INVITE has already carried, and to which nonce. */
interface AuthState {
  readonly attempt: number;
  readonly nonce: string | undefined;
}

const UNSIGNED: AuthState = { attempt: 0, nonce: undefined };

/** The client INVITE transaction we are waiting on (outbound calls only). */
interface Pending {
  readonly cseq: number;
  readonly auth: AuthState;
  readonly request: SipRequest;
  stop(): void;
}

type Stage = 'early' | 'answered' | 'confirmed';

interface Dialog {
  readonly entry: Entry;
  readonly role: Role;
  readonly callId: string;
  /** UAS: the INVITE we received. UAC: the first INVITE we sent. */
  readonly invite: SipRequest;
  readonly localTag: string;
  readonly sdpSession: string;
  /** The From header of every request we originate in this dialog. */
  readonly localHeader: string;
  remoteHeader: string;
  /** Request-URI for in-dialog requests: the peer's Contact. */
  target: string;
  routes: readonly string[];
  /** The last CSeq we used. */
  cseq: number;
  stage: Stage;
  rtpPort: number;
  direction: SdpDirection;
  plan: MediaPlan | undefined;
  media: LiveMedia | undefined;
  pending: Pending | undefined;
  setup: SetupGuard | undefined;
  /** The host our last SDP carried, to notice when the mapped address has since changed. */
  advertised: string;
  held: boolean;
  muted: boolean;
  cancelled: boolean;
  connectedAt: number | undefined;
  /** The connection whose address the far end last learned (Contact), so a replaced connection is announced once. */
  contactOn: SipConnection | undefined;
}

type DialogBase = Pick<
  Dialog,
  'entry' | 'role' | 'callId' | 'invite' | 'localTag' | 'sdpSession' | 'remoteHeader' | 'target' | 'routes' | 'direction' | 'plan' | 'rtpPort'
>;

function newEntry(account: SipAccount): Entry {
  return {
    account,
    snapshot: initialRegistration,
    candidate: undefined,
    connection: undefined,
    timer: undefined,
    stopped: false,
    sharing: undefined,
    sharingKey: undefined,
    failures: 0,
    raises: 0,
    expires: undefined,
    keepalive: undefined
  };
}

/* ------------------------------------------------------------------ wire */

const first = (headers: SipHeaders, name: string): string => headerValue(headers, name) ?? '';

const withTag = (to: string, tag: string): string => (/;\s*tag=/i.test(to) ? to : `${to};tag=${tag}`);

const NAME_ADDR = /^\s*(?:"([^"]*)"|([^<"]*?))?\s*<([^>]+)>/;

function uriIdentity(uri: string): string {
  try {
    const parsed = parseUri(uri);
    return parsed.user === undefined ? parsed.host : `${parsed.user}@${parsed.host}`;
  } catch {
    return uri;
  }
}

function identityOf(from: string): string {
  const [, quoted = '', bare = '', uri = from.split(';')[0] ?? ''] = NAME_ADDR.exec(from) ?? [];
  const display = (quoted || bare).trim();
  return display === '' ? uriIdentity(uri.trim()) : display;
}

const reachableAt = (connection: SipConnection): { host: string; port: number } =>
  connection.publicAddress ?? connection.localAddress;

function contactFor(entry: Entry, connection: SipConnection): string {
  const { host, port } = reachableAt(connection);
  return `<sip:${entry.account.username}@${host}:${port};transport=${connection.candidate.transport}>`;
}

interface ReplyOptions {
  readonly toTag: string;
  readonly contact?: string;
  readonly body?: string;
}

function buildReply(
  request: SipRequest,
  status: number,
  reason: string,
  options: ReplyOptions
): SipResponse {
  const headers: SipHeaders = {
    via: headerValues(request.headers, 'via'),
    'record-route': headerValues(request.headers, 'record-route'),
    from: [first(request.headers, 'from')],
    to: [withTag(first(request.headers, 'to'), options.toTag)],
    'call-id': [first(request.headers, 'call-id')],
    cseq: [first(request.headers, 'cseq')],
    'user-agent': [USER_AGENT],
    allow: [ALLOW],
    ...(options.contact === undefined ? {} : { contact: [options.contact] }),
    ...(options.body === undefined ? {} : { 'content-type': ['application/sdp'] })
  };
  return { kind: 'response', status, reason, headers, body: options.body ?? '' };
}

const isChallenge = (response: SipResponse): boolean => response.status === 401 || response.status === 407;

/** The CSeq number of a response to an INVITE, or undefined for any other method. */
function inviteCseq(response: SipResponse): number | undefined {
  const [number = '', method = ''] = first(response.headers, 'cseq').split(' ');
  return method === 'INVITE' ? Number.parseInt(number, 10) : undefined;
}

const stripBrackets = (contact: string): string => (/<([^>]+)>/.exec(contact)?.[1] ?? contact).split(';')[0] ?? contact;

const localHeaderOf = (entry: Entry, tag: string): string => `<${entry.account.uri}>;tag=${tag}`;

interface RequestParts {
  readonly entry: Entry;
  readonly from: string;
  readonly to: string;
  readonly callId: string;
  readonly cseq: string;
  readonly branch: string;
  readonly routes: readonly string[];
}

function requestHeaders(parts: RequestParts): SipHeaders {
  const connection = parts.entry.connection as SipConnection;
  const local = connection.localAddress;
  const transport = connection.candidate.transport.toUpperCase();
  return {
    via: [`SIP/2.0/${transport} ${local.host}:${local.port};branch=${parts.branch};rport`],
    'max-forwards': ['70'],
    route: parts.routes,
    from: [parts.from],
    to: [parts.to],
    'call-id': [parts.callId],
    cseq: [parts.cseq],
    contact: [contactFor(parts.entry, connection)],
    'user-agent': [USER_AGENT]
  };
}

function buildDialogRequest(dialog: Dialog, method: string, cseq: number, branch: string, body?: string): SipRequest {
  const headers = requestHeaders({
    entry: dialog.entry,
    from: dialog.localHeader,
    to: dialog.remoteHeader,
    callId: dialog.callId,
    cseq: `${cseq} ${method}`,
    branch,
    routes: dialog.routes
  });
  const typed = body === undefined ? headers : withHeader(headers, 'content-type', 'application/sdp');
  return { kind: 'request', method, uri: dialog.target, headers: typed, body: body ?? '' };
}

type InviteParty = Pick<Dialog, 'entry' | 'localHeader' | 'target' | 'callId'>;

function buildInvite(dialog: InviteParty, cseq: number, branch: string, body: string, auth?: Credentials): SipRequest {
  const headers = requestHeaders({
    entry: dialog.entry,
    from: dialog.localHeader,
    to: `<${dialog.target}>`,
    callId: dialog.callId,
    cseq: `${cseq} INVITE`,
    branch,
    routes: []
  });
  const typed = withHeader(withHeader(headers, 'content-type', 'application/sdp'), 'allow', ALLOW);
  const signed = auth === undefined ? typed : withHeader(typed, auth.header, auth.value);
  return { kind: 'request', method: 'INVITE', uri: dialog.target, headers: signed, body };
}

const pick = (headers: SipHeaders, names: readonly string[]): SipHeaders =>
  Object.fromEntries(names.map((name) => [name, headerValues(headers, name)] as const).filter(([, values]) => values.length > 0));

/** CANCEL repeats the INVITE's Via (same branch), URI, From, To and Call-ID (RFC 3261 9.1). */
function buildCancel(invite: SipRequest): SipRequest {
  const cseq = `${Number.parseInt(first(invite.headers, 'cseq'), 10)} CANCEL`;
  const headers = withHeader(pick(invite.headers, ['via', 'max-forwards', 'from', 'to', 'call-id', 'user-agent']), 'cseq', cseq);
  return { kind: 'request', method: 'CANCEL', uri: invite.uri, headers, body: '' };
}

/** The ACK for a non-2xx final response is part of the INVITE transaction: same branch and CSeq number. */
function buildFailureAck(invite: SipRequest, response: SipResponse): SipRequest {
  const cseq = `${Number.parseInt(first(invite.headers, 'cseq'), 10)} ACK`;
  const base = pick(invite.headers, ['via', 'max-forwards', 'from', 'call-id', 'route', 'user-agent']);
  const headers = withHeader(withHeader(base, 'to', first(response.headers, 'to')), 'cseq', cseq);
  return { kind: 'request', method: 'ACK', uri: invite.uri, headers, body: '' };
}

/* ------------------------------------------------------------------- SDP */

interface Negotiated {
  readonly plan: MediaPlan;
  readonly direction: SdpDirection;
}

function telephoneEventType(rtpmap: Readonly<Record<number, string>>): number | undefined {
  const found = Object.entries(rtpmap).find(([, codec]) => /^telephone-event\/8000/i.test(codec));
  return found === undefined ? undefined : Number(found[0]);
}

function planOf(description: SessionDescription, payloadType: number): MediaPlan | undefined {
  const { port, rtpmap } = description.audio;
  if (port === 0) return undefined;
  return { payloadType, dtmfPayloadType: telephoneEventType(rtpmap), host: description.connectionAddress, port };
}

/** An offer or an answer we cannot use (no body, malformed, no shared codec, stream refused) yields undefined. */
function negotiateBody(body: string): Negotiated | undefined {
  try {
    const description = parseSdp(body);
    const { payloadType, direction } = negotiate(description, SUPPORTED_CODECS);
    const plan = planOf(description, payloadType);
    return plan === undefined ? undefined : { plan, direction };
  } catch (error) {
    if (error instanceof MalformedSdpError || error instanceof NoCommonCodecError) return undefined;
    throw error;
  }
}

/* ---------------------------------------------------------- client timers */

/** Timer A resends an unanswered INVITE over UDP; timer B gives up (RFC 3261 17.1.1). */
function startInviteTimers(resend: () => void, onTimeout: () => void, datagram: boolean): () => void {
  const state = { sent: 1, delay: TIMER_T1_MS, resend: undefined as Timer | undefined };
  const timeout = setTimeout(onTimeout, UDP_TRANSACTION_TIMEOUT_MS);
  const tick = (): void => {
    resend();
    state.sent += 1;
    state.delay *= 2;
    if (state.sent < UDP_MAX_TRANSMISSIONS) state.resend = setTimeout(tick, state.delay);
  };
  if (datagram) state.resend = setTimeout(tick, state.delay);
  return () => {
    clearTimeout(timeout);
    clearTimeout(state.resend);
  };
}

/* ---------------------------------------------------------------- engine */

const noMedia: MediaBridge = {
  start: (): void => undefined,
  stop: (): void => undefined,
  play: (): void => undefined,
  onCapture: () => (): void => undefined,
  dispose: (): void => undefined
};

const defaultRtp: RtpFactory = {
  allocatePort: () => allocateRtpPort(),
  create: (options) =>
    createRtpSession(options, {
      onError: (error) => log('warn', `rtp: ${String(error)}`),
      onNotice: (level, message) => log(level, message)
    })
};

const defaultDeps = (): EngineDeps => ({
  probe: createProbeDeps(),
  ids: defaultIdFactory,
  open: openConnection,
  diagnostics: createDiagnosticsLog(),
  media: noMedia,
  rtp: defaultRtp,
  now: () => Date.now(),
  random: () => Math.random()
});

const technical = (error: unknown): string =>
  (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.message : String(error));

/** What the retry policy needs to know about a REGISTER that was refused. */
function failureOf(result: Extract<RegisterResult, { ok: false }>, requested: number, raises: number): RegistrationFailure {
  const { status, retryAfter, minExpires } = result;
  return {
    kind: 'response',
    status,
    requested,
    raises,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(minExpires === undefined ? {} : { minExpires })
  };
}

const fail = (errorKey: string): DialResult => ({ ok: false, errorKey });

interface Note {
  readonly params?: Readonly<Record<string, string>>;
  readonly level?: LogLevel;
  readonly raw?: string;
}

function sessionOptions(localPort: number, plan: MediaPlan): RtpSessionOptions {
  return {
    localPort,
    remoteHost: plan.host,
    remotePort: plan.port,
    payloadType: plan.payloadType,
    ...(plan.dtmfPayloadType === undefined ? {} : { dtmfPayloadType: plan.dtmfPayloadType })
  };
}

function trackFields(track: CallTrack | undefined): Pick<CallView, 'progress' | 'endReasonKey'> {
  const { progress, endReasonKey } = track ?? {};
  return {
    ...(progress === undefined ? {} : { progress }),
    ...(endReasonKey === undefined ? {} : { endReasonKey })
  };
}

function viewOf(call: CallSession, dialog: Dialog | undefined, track?: CallTrack): CallView {
  const connectedAt = dialog?.connectedAt;
  const media = dialog?.media;
  return {
    call,
    ...trackFields(track),
    ...(connectedAt === undefined ? {} : { connectedAt }),
    ...(media === undefined || dialog === undefined ? {} : { media: { ...media.session.stats, muted: dialog.muted } })
  };
}

/** Every engine that has been created and not stopped, so the main process can wake them without owning one. */
const liveEngines = new Set<SipEngine>();

/** The machine resumed or was unlocked: every live engine re-registers what it holds, if anything. */
export function resumeAllEngines(): void {
  liveEngines.forEach((engine) => engine.reregisterAll());
}

export class SipEngine {
  private readonly entries = new Map<AccountId, Entry>();
  private readonly dialogs = new Map<string, Dialog>();
  private readonly tracks = new Map<string, CallTrack>();
  private registry: CallRegistry = emptyCallRegistry;
  private readonly listeners = new Set<Listener>();
  private readonly deps: EngineDeps;
  private readonly stopCapture: () => void;

  constructor(deps: Partial<EngineDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
    this.stopCapture = this.deps.media.onCapture((callId, samples) =>
      this.dialogs.get(callId)?.media?.session.sendPcm(samples)
    );
    liveEngines.add(this);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCallViews(): readonly CallView[] {
    const shown = Object.values(this.registry).filter((call) => call.state !== 'ended' || this.lingers(call.id));
    return shown.map((call) => viewOf(call, this.dialogs.get(call.id), this.tracks.get(call.id)));
  }

  /** Records what the call is doing now and mirrors it to the diagnostics log once per change. */
  private setProgress(callId: string, progress: string): void {
    const track = this.tracks.get(callId) ?? {};
    this.tracks.set(callId, track);
    if (track.progress === progress) return;
    track.progress = progress;
    this.note(this.registry[callId]?.accountId, progress, { params: { callId } });
    this.emit();
  }

  /** Lazy expiry: no timer decides this, the clock is read each time the views are built. */
  private lingers(callId: string): boolean {
    const endedAt = this.tracks.get(callId)?.endedAt;
    return endedAt !== undefined && this.deps.now() - endedAt < ENDED_CALL_LINGER_MS;
  }

  /** One wake-up when the window closes, so the UI re-renders without the row being dropped by a timer. */
  private scheduleLapse(callId: string): void {
    const lapse = setTimeout(() => {
      if (this.tracks.delete(callId)) this.emit();
    }, ENDED_CALL_LINGER_MS);
    lapse.unref();
  }

  /** Remembers why a call failed, when the user should be told. */
  private recordEnd(callId: string, status: number): void {
    const endReasonKey = END_REASON_BY_STATUS[status];
    if (endReasonKey === undefined) return;
    this.recordReason(callId, endReasonKey, { params: { callId, status: String(status) } });
  }

  private recordReason(callId: string, endReasonKey: string, details: Note): void {
    this.setProgress(callId, PROGRESS_ENDED);
    const track = this.tracks.get(callId);
    if (track !== undefined) {
      track.endReasonKey = endReasonKey;
      track.endedAt = this.deps.now();
      this.scheduleLapse(callId);
    }
    this.note(this.registry[callId]?.accountId, endReasonKey, details);
  }

  /** Drops the ended-call notices of one account when it starts a new call. */
  private forgetFinished(accountId: AccountId): void {
    for (const [callId, track] of this.tracks) {
      const call = this.registry[callId];
      if (call?.accountId === accountId && call.state === 'ended' && track.endReasonKey !== undefined) {
        this.tracks.delete(callId);
      }
    }
  }

  /** Per account: how many other devices hold it, and whether our own binding was displaced. */
  getSharing(): Readonly<Record<AccountId, AccountSharing>> {
    const known = [...this.entries].flatMap(([id, entry]) => (entry.sharing === undefined ? [] : [[id, entry.sharing] as const]));
    return Object.fromEntries(known);
  }

  getRegistrations(): Readonly<Record<AccountId, RegistrationSnapshot>> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.snapshot]));
  }

  getTransports(): Readonly<Record<AccountId, TransportCandidate>> {
    const found = [...this.entries].flatMap(([id, entry]) =>
      entry.candidate === undefined ? [] : [[id, entry.candidate] as const]
    );
    return Object.fromEntries(found);
  }

  async start(accounts: readonly SipAccount[]): Promise<void> {
    await Promise.all(accounts.map((account) => this.startAccount(account)));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stopAccount(id)));
    this.stopCapture();
    liveEngines.delete(this);
  }

  /** Returns once the account is registering; discovery and REGISTER continue in the background. */
  async startAccount(account: SipAccount): Promise<void> {
    await this.stopAccount(account.id);
    const entry = newEntry(account);
    this.entries.set(account.id, entry);
    this.dispatchRegistration(entry, { type: 'register' });
    void this.run(entry);
  }

  async stopAccount(id: AccountId): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.stopped = true;
    this.entries.delete(id);
    this.clearTimer(entry);
    await this.unregister(entry);
    this.endCallsOf(entry.account.id);
    this.dropConnection(entry);
    this.emit();
  }

  /* ------------------------------------------------------------- calls */

  async answer(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'answer' })) return;
    try {
      dialog.rtpPort = await this.deps.rtp.allocatePort();
    } catch (error) {
      return this.abandon(dialog, `no RTP port: ${String(error)}`);
    }
    if (this.dialogs.get(callId) !== dialog) return;
    dialog.stage = 'answered';
    await this.reply(dialog, 200, 'OK', this.sdpFor(dialog, dialog.direction));
  }

  async reject(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'reject' })) return;
    this.releaseDialog(dialog);
    await this.reply(dialog, 603, 'Decline');
  }

  async hangup(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    const ringing = this.registry[callId]?.state === 'ringing';
    if (!this.dispatchCall(callId, { type: ringing ? 'reject' : 'hangup' })) return;
    if (dialog.role === 'uac' && dialog.stage === 'early') return this.cancel(dialog);
    this.releaseDialog(dialog);
    if (ringing) await this.reply(dialog, 603, 'Decline');
    else await this.sendRequest(dialog, 'BYE');
  }

  async hold(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'hold' })) return;
    dialog.held = true;
    dialog.direction = holdDirection(dialog.direction);
    this.applyMute(dialog);
    await this.sendRequest(dialog, 'INVITE', this.sdpFor(dialog, dialog.direction));
  }

  async resume(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'resume' })) return;
    dialog.held = false;
    dialog.direction = resumeDirection(dialog.direction);
    this.applyMute(dialog);
    await this.sendRequest(dialog, 'INVITE', this.sdpFor(dialog, dialog.direction));
  }

  sendDtmf(callId: string, digit: DtmfDigit): void {
    this.dialogs.get(callId)?.media?.session.sendDtmf(digit);
  }

  setMuted(callId: string, muted: boolean): void {
    const dialog = this.dialogs.get(callId);
    if (dialog === undefined) return;
    dialog.muted = muted;
    this.applyMute(dialog);
    this.emit();
  }

  /** Places a call. Resolves once the INVITE is on its way; later failures end the call and are logged. */
  async dial(accountId: AccountId, target: string): Promise<DialResult> {
    const entry = this.entries.get(accountId);
    if (entry?.connection === undefined || entry.snapshot.state !== 'registered') return fail('calls.error.notRegistered');
    const uri = this.normalise(target, entry.account.domain);
    if (uri === undefined) return fail('calls.error.invalidTarget');
    if (Object.values(this.registry).some((call) => isOutboundInSetup(call, accountId))) return fail(SETUP_IN_PROGRESS_KEY);
    this.warnIfUnmapped(entry, entry.connection);
    const callId = this.deps.ids.newCallId(reachableAt(entry.connection).host);
    this.forgetFinished(accountId);
    const refusal = this.openOutgoing({ id: callId, accountId, target: uri });
    if (refusal !== undefined) return fail(refusal);
    return this.launch(entry, callId, uri);
  }

  /* ------------------------------------------------------ outbound calls */

  private normalise(target: string, domain: string): string | undefined {
    try {
      return normaliseTarget(target, domain);
    } catch (error) {
      if (error instanceof InvalidCallTargetError) return undefined;
      throw error;
    }
  }

  private openOutgoing(params: { id: string; accountId: AccountId; target: string }): string | undefined {
    try {
      this.registry = outgoingCall(this.registry, params);
      return undefined;
    } catch (error) {
      if (error instanceof ConcurrentCallLimitError) return 'calls.error.limitReached';
      throw error;
    }
  }

  private async launch(entry: Entry, callId: string, uri: string): Promise<DialResult> {
    try {
      const dialog = this.newOutbound(entry, callId, uri, await this.deps.rtp.allocatePort());
      this.dialogs.set(callId, dialog);
      this.transmitInvite(dialog, dialog.invite, UNSIGNED);
      dialog.setup = this.startSetupGuard(dialog);
    } catch (error) {
      this.dispatchCall(callId, { type: 'hangup' });
      this.note(entry.account.id, CALL_FAILED_KEY, { level: 'warn', params: { reason: technical(error) } });
      return fail(CALL_FAILED_KEY);
    }
    return { ok: true, callId };
  }

  private newOutbound(entry: Entry, callId: string, uri: string, rtpPort: number): Dialog {
    const localTag = this.deps.ids.newTag();
    const sdpSession = this.sessionId();
    const address = this.hostOfEntry(entry);
    const body = buildOffer({ address, port: rtpPort, sessionId: sdpSession, direction: 'sendrecv' });
    const party: InviteParty = { entry, callId, target: uri, localHeader: localHeaderOf(entry, localTag) };
    const invite = buildInvite(party, 1, this.deps.ids.newBranch(), body);
    const remoteHeader = `<${uri}>`;
    const dialog = this.newDialog({
      entry, role: 'uac', callId, invite, localTag, sdpSession, remoteHeader,
      target: uri, routes: [], direction: 'sendrecv', plan: undefined, rtpPort
    });
    dialog.advertised = address;
    return dialog;
  }

  private sessionId(): string {
    return String(Math.floor(this.deps.now() / 1000));
  }

  private transmitInvite(dialog: Dialog, request: SipRequest, auth: AuthState): void {
    const { connection } = dialog.entry;
    if (connection === undefined) return;
    const send = (): void => void connection.send(request).catch(this.logSend);
    send();
    const stop = startInviteTimers(send, () => this.failCall(dialog, STATUS_REQUEST_TIMEOUT), connection.candidate.transport === 'udp');
    dialog.pending = { cseq: dialog.cseq, auth, request, stop };
  }

  private onInviteResponse(dialog: Dialog, response: SipResponse): void {
    dialog.pending?.stop();
    if (response.status < 200) return this.onProvisional(dialog, response.status);
    if (response.status < 300) return this.onAnswered(dialog, response);
    this.onInviteRejected(dialog, response);
  }

  /** A repeated 100 must not drag "ringing" or "waiting" back to "trying". */
  private onProvisional(dialog: Dialog, status: number): void {
    const progress = PROGRESS_BY_STATUS[status];
    if (progress === undefined) return;
    const trying = progress === PROGRESS_TRYING;
    if (trying && this.tracks.get(dialog.callId)?.progress !== undefined) return;
    this.setProgress(dialog.callId, progress);
    if (trying) this.armWaiting(dialog);
  }

  /* ----------------------------------------------------- setup guard */

  private startSetupGuard(dialog: Dialog): SetupGuard {
    const expiry = setTimeout(() => this.expireSetup(dialog), CALL_SETUP_TIMEOUT_MS);
    expiry.unref();
    return { expiry, waiting: undefined };
  }

  private armWaiting(dialog: Dialog): void {
    const { setup } = dialog;
    if (setup === undefined) return;
    setup.waiting = setTimeout(() => this.showWaiting(dialog), CALL_WAITING_GRACE_MS);
    setup.waiting.unref();
  }

  private showWaiting(dialog: Dialog): void {
    if (this.tracks.get(dialog.callId)?.progress === PROGRESS_TRYING) this.setProgress(dialog.callId, PROGRESS_WAITING);
  }

  private stopSetupGuard(dialog: Dialog): void {
    const { setup } = dialog;
    dialog.setup = undefined;
    clearTimeout(setup?.expiry);
    clearTimeout(setup?.waiting);
  }

  /** No final response in time: tell the user why, end the call, and CANCEL the INVITE (RFC 3261 9.1). */
  private expireSetup(dialog: Dialog): void {
    this.stopSetupGuard(dialog);
    const { callId } = dialog;
    this.recordReason(callId, END_REASON_SETUP_TIMEOUT, {
      level: 'warn',
      params: { callId, seconds: String(CALL_SETUP_TIMEOUT_MS / 1000) }
    });
    this.dispatchCall(callId, { type: 'hangup' });
    this.cancel(dialog).catch(this.logSend);
  }

  /** A challenge we answer with credentials is not the end of setup: the guard keeps its original deadline. */
  private onInviteRejected(dialog: Dialog, response: SipResponse): void {
    const { pending } = dialog;
    dialog.pending = undefined;
    if (pending !== undefined) this.sendAckTo(dialog, buildFailureAck(pending.request, response));
    if (dialog.cancelled) return void this.dialogs.delete(dialog.callId);
    if (isChallenge(response) && pending !== undefined && this.retryWithCredentials(dialog, response, pending.auth)) return;
    this.failCall(dialog, response.status);
  }

  /** One digest answer per fresh challenge: a repeated nonce, or too many rounds, means the credentials are wrong. */
  private retryWithCredentials(dialog: Dialog, response: SipResponse, previous: AuthState): boolean {
    if (previous.attempt >= MAX_AUTH_ATTEMPTS) return false;
    const credentials = this.credentialsFor(dialog, response);
    if (credentials === undefined || repeatsNonce(credentials, previous.nonce)) return false;
    dialog.cseq += 1;
    const body = this.sdpFor(dialog, 'sendrecv');
    const invite = buildInvite(dialog, dialog.cseq, this.deps.ids.newBranch(), body, credentials);
    this.transmitInvite(dialog, invite, { attempt: previous.attempt + 1, nonce: credentials.nonce });
    return true;
  }

  /** The digest URI is the INVITE's own request URI, not the registrar's. */
  private credentialsFor(dialog: Dialog, response: SipResponse): Credentials | undefined {
    const { username, password } = dialog.entry.account;
    const newCnonce = (): string => this.deps.ids.newCnonce();
    return credentialsFor(response, { username, password, method: 'INVITE', digestUri: dialog.target, newCnonce, hash: md5 });
  }

  private onAnswered(dialog: Dialog, response: SipResponse): void {
    const cseq = Number.parseInt(first(response.headers, 'cseq'), 10);
    dialog.pending = undefined;
    this.stopSetupGuard(dialog);
    this.adoptRemote(dialog, response);
    this.sendAckTo(dialog, buildDialogRequest(dialog, 'ACK', cseq, this.deps.ids.newBranch()));
    const negotiated = negotiateBody(response.body);
    if (dialog.cancelled || negotiated === undefined) return this.endAnswered(dialog);
    dialog.plan = negotiated.plan;
    dialog.stage = 'confirmed';
    if (!this.dispatchCall(dialog.callId, { type: 'connected' })) return;
    this.setProgress(dialog.callId, PROGRESS_CONNECTING);
    this.startMedia(dialog);
    this.reofferStale(dialog.entry);
  }

  /** A 2xx we cannot use, or one that crossed our CANCEL: acknowledge it, then hang up at once. */
  private endAnswered(dialog: Dialog): void {
    if (!dialog.cancelled) {
      this.dispatchCall(dialog.callId, { type: 'hangup' });
      this.note(dialog.entry.account.id, CALL_FAILED_KEY, { level: 'warn' });
    }
    this.releaseDialog(dialog);
    this.sendRequest(dialog, 'BYE').catch(this.logSend);
  }

  private adoptRemote(dialog: Dialog, response: SipResponse): void {
    const contact = headerValue(response.headers, 'contact');
    dialog.remoteHeader = first(response.headers, 'to') || dialog.remoteHeader;
    dialog.target = contact === undefined ? dialog.target : stripBrackets(contact);
    dialog.routes = [...headerValues(response.headers, 'record-route')].reverse();
  }

  private failCall(dialog: Dialog, status: number): void {
    dialog.pending?.stop();
    this.recordEnd(dialog.callId, status);
    this.note(dialog.entry.account.id, CALL_FAILED_KEY, { level: 'warn' });
    this.releaseDialog(dialog);
    this.dispatchCall(dialog.callId, { type: 'remoteHangup' });
  }

  private async cancel(dialog: Dialog): Promise<void> {
    dialog.cancelled = true;
    this.stopSetupGuard(dialog);
    const request = dialog.pending?.request;
    dialog.pending?.stop();
    if (request === undefined) return void this.dialogs.delete(dialog.callId);
    const forget = setTimeout(() => this.dialogs.delete(dialog.callId), UDP_TRANSACTION_TIMEOUT_MS);
    forget.unref();
    await dialog.entry.connection?.send(buildCancel(request));
  }

  /** Dialog bookkeeping once a call is over: no more timers, media or lookups. */
  private releaseDialog(dialog: Dialog): void {
    this.dialogs.delete(dialog.callId);
    dialog.pending?.stop();
    this.stopSetupGuard(dialog);
    this.stopMedia(dialog);
  }

  private abandon(dialog: Dialog, reason: string): void {
    log('warn', `abandoning call ${dialog.callId}: ${reason}`);
    this.dispatchCall(dialog.callId, { type: 'hangup' });
    this.releaseDialog(dialog);
    this.reply(dialog, 500, 'Server Internal Error').catch(this.logSend);
  }

  /* -------------------------------------------------------------- media */

  private startMedia(dialog: Dialog): void {
    const { plan } = dialog;
    if (plan === undefined || dialog.media !== undefined) return;
    try {
      const session = this.deps.rtp.create(sessionOptions(dialog.rtpPort, plan));
      const stopPlayback = session.onPcm((frame) => {
        if (!dialog.held) this.deps.media.play(dialog.callId, frame);
      });
      this.deps.media.start(dialog.callId);
      dialog.media = { session, stopPlayback };
      this.applyMute(dialog);
      this.setProgress(dialog.callId, PROGRESS_ACTIVE);
    } catch (error) {
      log('warn', `media for ${dialog.callId} not started: ${String(error)}`);
    }
    this.emit();
  }

  private stopMedia(dialog: Dialog): void {
    const { media } = dialog;
    if (media === undefined) return;
    dialog.media = undefined;
    media.stopPlayback();
    media.session.close();
    this.deps.media.stop(dialog.callId);
  }

  /** Hold keeps the stream alive but silent; the user's own mute state is reported separately. */
  private applyMute(dialog: Dialog): void {
    dialog.media?.session.setMuted(dialog.muted || dialog.held);
    dialog.media?.session.setHeld(dialog.held);
  }

  /** The peer moved its media (or we learned it late): restart the session on the same local port. */
  private adoptMedia(dialog: Dialog, body: string): void {
    const negotiated = negotiateBody(body);
    const { plan, media } = dialog;
    if (negotiated === undefined || plan === undefined || media === undefined) return;
    const moved = negotiated.plan.host !== plan.host || negotiated.plan.port !== plan.port;
    dialog.plan = negotiated.plan;
    if (!moved) return;
    media.stopPlayback();
    media.session.close();
    dialog.media = undefined;
    this.deps.media.stop(dialog.callId);
    this.startMedia(dialog);
  }

  private sdpFor(dialog: Dialog, direction: SdpDirection): string {
    dialog.advertised = this.hostOf(dialog);
    return buildOffer({
      address: dialog.advertised,
      port: dialog.rtpPort,
      sessionId: dialog.sdpSession,
      direction,
      ...(dialog.plan === undefined ? {} : { payloadTypes: [dialog.plan.payloadType] })
    });
  }

  /* ------------------------------------------------------- diagnostics */

  private note(accountId: string | undefined, messageKey: string, details: Note = {}): void {
    const diagnostics = this.deps.diagnostics;
    const stored = diagnostics.append({
      level: details.level ?? 'info',
      messageKey,
      ...(accountId === undefined ? {} : { accountId }),
      ...(details.params === undefined ? {} : { params: details.params }),
      ...(details.raw === undefined ? {} : { raw: details.raw })
    });
    if (stored !== undefined) this.emit();
  }

  private traceSent(entry: Entry, message: SipMessage): void {
    const method = isResponse(message) ? String(message.status) : message.method;
    this.traceWire(entry, 'logs.event.sent', { method }, message);
  }

  private traceReceived(entry: Entry, message: SipMessage): void {
    const status = isResponse(message) ? String(message.status) : message.method;
    this.traceWire(entry, 'logs.event.received', { status }, message);
  }

  private traceWire(entry: Entry, key: string, params: Record<string, string>, message: SipMessage): void {
    if (!this.deps.diagnostics.debug) return;
    this.note(entry.account.id, key, { level: 'debug', params, raw: serialize(message) });
  }

  private instrument(entry: Entry, connection: SipConnection): void {
    const send = connection.send.bind(connection);
    connection.send = (message): Promise<void> => {
      this.traceSent(entry, message);
      this.noteTraffic(entry, noteSent);
      return send(message);
    };
    const keepalive = connection.sendKeepalive.bind(connection);
    connection.sendKeepalive = (): Promise<void> => {
      this.noteTraffic(entry, noteSent);
      return keepalive();
    };
  }

  /* ------------------------------------------------------- registration */

  private async run(entry: Entry): Promise<void> {
    try {
      const { domain, serverUri } = entry.account;
      const params = serverUri === undefined ? { domain } : { domain, manualUri: serverUri };
      const { candidate } = await discoverTransport(params, this.loggedProbes(entry));
      if (entry.stopped) return;
      entry.candidate = candidate;
      this.note(entry.account.id, 'logs.event.transport', { params: { transport: candidate.transport } });
      const onNotice: ConnectionDeps['onNotice'] = ({ level, messageKey, params }) =>
        this.note(entry.account.id, messageKey, { level, params });
      await this.attach(entry, await this.deps.open(candidate, { onNotice }));
    } catch (error) {
      this.fail(entry, this.failureKey(error), TRANSPORT_FAILURE);
    }
  }

  private loggedProbes(entry: Entry): ProbeDeps {
    const probes = this.deps.probe;
    return {
      ...probes,
      probe: (candidate, timeoutMs): Promise<number> => {
        const params = { transport: candidate.transport, host: candidate.host };
        this.note(entry.account.id, 'logs.event.probe', { params });
        return probes.probe(candidate, timeoutMs);
      }
    };
  }

  private failureKey(error: unknown): string {
    return error instanceof Error && error.name === 'NoReachableTransportError'
      ? TRANSPORT_ERROR_KEYS.noneReachable
      : technical(error);
  }

  private async attach(entry: Entry, connection: SipConnection): Promise<void> {
    if (entry.stopped) {
      connection.close();
      return;
    }
    const previous = entry.connection;
    entry.connection = connection;
    this.instrument(entry, connection);
    connection.onActivity(() => this.noteTraffic(entry, noteInbound));
    connection.onMessage((message) => this.onMessage(entry, message));
    connection.onClose((reason) => this.onClosed(entry, connection, reason));
    previous?.close();
    await this.refresh(entry);
  }

  private async refresh(entry: Entry): Promise<void> {
    const { connection, candidate, account } = entry;
    if (connection === undefined || candidate === undefined) return;
    const requested = entry.expires ?? account.registerExpires;
    const result = await register({ account, candidate, expires: requested }, { connection, ids: this.deps.ids, hash: md5 });
    if (entry.stopped || entry.connection !== connection) return;
    if (!result.ok) return this.fail(entry, result.errorKey, failureOf(result, requested, entry.raises));
    entry.failures = 0;
    entry.raises = 0;
    this.note(account.id, 'logs.event.registered', { params: { expires: String(result.expiresIn) } });
    this.trackSharing(entry, result);
    if (entry.snapshot.state === 'registering') this.dispatchRegistration(entry, { type: 'registered' });
    this.beginKeepalive(entry);
    this.recoverCalls(entry);
    const delay = Math.max(MIN_REFRESH_MS, Math.floor(result.expiresIn * REFRESH_FRACTION * 1000));
    entry.timer = setTimeout(() => void this.refresh(entry), delay);
  }

  /** Remembers who else holds the account and warns once per change, not on every refresh. */
  private trackSharing(entry: Entry, result: AcceptedRegistration): void {
    const { sharing, otherContacts } = result;
    const contacts = otherContacts.join(', ');
    const key = `${sharing.others}|${sharing.displaced}|${contacts}`;
    entry.sharing = { others: sharing.others, displaced: sharing.displaced };
    if (entry.sharingKey === key) return;
    entry.sharingKey = key;
    if (sharing.others > 0) this.note(entry.account.id, 'logs.event.shared', { level: 'warn', params: { contacts } });
    if (sharing.displaced) this.note(entry.account.id, 'logs.event.displaced', { level: 'warn' });
  }

  private forgetSharing(entry: Entry): void {
    entry.sharing = undefined;
    entry.sharingKey = undefined;
  }

  private noteMappedAddress(entry: Entry, before: SipConnection['publicAddress'], after: SipConnection['publicAddress']): void {
    if (after === undefined || (before?.host === after.host && before.port === after.port)) return;
    this.note(entry.account.id, 'logs.event.nat', { params: { address: `${after.host}:${after.port}` } });
  }

  /**
   * Whether and when to try again is core/sip/retry.ts's decision. A 423 is not a failure at all: the
   * registrar named the shortest Expires it accepts, so register again with that.
   *
   * A registration problem never ends a call: the media path is another socket and address, so the RTP
   * watchdog (core/rtp/flow.ts) is what judges a call. Only stopAccount, the far end, the user and the call's
   * own guards end one.
   */
  private fail(entry: Entry, reason: string, failure: RegistrationFailure): void {
    if (entry.stopped) return;
    const decision = decideRetry(failure, entry.failures + 1, this.deps.random());
    if (decision.action === 'reregister') return this.raiseExpires(entry, decision.expires);
    entry.failures += 1;
    this.forgetSharing(entry);
    this.clearTimer(entry);
    this.dropConnection(entry);
    this.dispatchRegistration(entry, { type: 'failed', reason });
    if (decision.action === 'retry') this.scheduleRetry(entry, decision.delayMs);
  }

  private scheduleRetry(entry: Entry, delayMs: number): void {
    this.note(entry.account.id, 'logs.event.retry', { params: { seconds: String(Math.ceil(delayMs / 1000)) } });
    entry.timer = setTimeout(() => this.retry(entry), delayMs);
  }

  private raiseExpires(entry: Entry, expires: number): void {
    entry.expires = expires;
    entry.raises += 1;
    this.note(entry.account.id, 'logs.event.minExpires', { params: { expires: String(expires) } });
    this.clearTimer(entry);
    void this.refresh(entry);
  }

  private retry(entry: Entry): void {
    if (entry.stopped) return;
    this.dispatchRegistration(entry, { type: 'retry' });
    void this.run(entry);
  }

  private onClosed(entry: Entry, connection: SipConnection, reason: string): void {
    if (entry.stopped || entry.connection !== connection) return;
    log('warn', `connection closed: ${reason}`);
    this.fail(entry, reason, TRANSPORT_FAILURE);
  }

  /* ------------------------------------------------- wake from sleep */

  /**
   * The machine woke up (or was unlocked): NAT bindings made before the sleep are gone and TCP connections
   * are probably dead, so do not wait for the refresh timer. A registered account refreshes on its current
   * connection (a dead one fails that REGISTER and is replaced through the normal retry path); one waiting
   * out a backoff retries now. A terminally failed account, and one still registering, are left alone.
   */
  reregisterAll(): void {
    const awake = [...this.entries.values()].filter((entry) => this.wake(entry));
    if (awake.length > 0) log('info', `resumed: re-registering ${awake.length} account(s)`);
  }

  private wake(entry: Entry): boolean {
    const { state } = entry.snapshot;
    const waiting = state === 'failed' && entry.timer !== undefined;
    if (entry.stopped || (state !== 'registered' && !waiting)) return false;
    this.note(entry.account.id, 'logs.event.resumed');
    this.clearTimer(entry);
    entry.failures = 0;
    if (entry.keepalive !== undefined) entry.keepalive.state = freshKeepalive(this.deps.now(), this.mediaPackets(entry));
    if (waiting) this.retry(entry);
    else void this.refresh(entry);
    return true;
  }

  /* ----------------------------------------- keepalive, dead flow */

  /**
   * Pings the server while registered. Outbound traffic keeps the NAT binding open; inbound traffic, of any
   * kind (a response to our ping, the server's own CRLF pings once the connection surfaces them), is the
   * evidence that the path still works. The decisions are core/sip/keepalive.ts's; this owns the timer.
   */
  private beginKeepalive(entry: Entry): void {
    if (entry.keepalive !== undefined) return;
    const timer = setInterval(() => this.tickKeepalive(entry), KEEPALIVE_TICK_MS);
    entry.keepalive = { state: freshKeepalive(this.deps.now(), this.mediaPackets(entry)), timer, cseq: 0 };
  }

  private endKeepalive(entry: Entry): void {
    if (entry.keepalive !== undefined) clearInterval(entry.keepalive.timer);
    entry.keepalive = undefined;
  }

  /**
   * Inbound RTP packets across this account's calls. Media arriving proves the network is up, so a call that
   * is still receiving audio vouches for the flow; a call that went quiet vouches for nothing, and that is
   * judged by the RTP watchdog, not here.
   */
  private mediaPackets(entry: Entry): number {
    return [...this.dialogs.values()]
      .filter((dialog) => dialog.entry === entry)
      .reduce((total, dialog) => total + (dialog.media?.session.stats.rxPackets ?? 0), 0);
  }

  private tickKeepalive(entry: Entry): void {
    const { keepalive, connection } = entry;
    if (keepalive === undefined || connection === undefined) return;
    const now = this.deps.now();
    keepalive.state = noteMedia(keepalive.state, this.mediaPackets(entry), now);
    const action = decideKeepalive(keepalive.state, now, keepalivePolicy(connection.candidate.transport));
    if (action === 'ping') this.ping(entry, connection, keepalive);
    else if (action === 'dead') this.declareDead(entry);
  }

  private ping(entry: Entry, connection: SipConnection, keepalive: Keepalive): void {
    if (keepaliveMethod(connection.candidate.transport) === 'crlf') {
      connection.sendKeepalive().catch(() => undefined);
      return;
    }
    keepalive.cseq += 1;
    const { account } = entry;
    const request = buildOptionsRequest(
      { account, candidate: connection.candidate, expires: 0, localAddress: connection.localAddress },
      this.deps.ids,
      keepalive.cseq
    );
    connection.send(request).catch(() => undefined);
  }

  /**
   * Silence is an inference, so acting on it must be reversible: the connection is replaced and the account
   * registers again at once, but no call is ended (the RTP watchdog judges calls). The old connection stays in
   * place until the new one is attached, so a BYE sent in between still has a socket to try.
   */
  private declareDead(entry: Entry): void {
    this.note(entry.account.id, 'logs.event.deadFlow', { level: 'warn' });
    entry.failures += 1;
    this.forgetSharing(entry);
    this.clearTimer(entry);
    this.endKeepalive(entry);
    this.dispatchRegistration(entry, { type: 'failed', reason: DEAD_FLOW_KEY });
    this.retry(entry);
  }

  private noteTraffic(entry: Entry, update: (state: KeepaliveState, now: number) => KeepaliveState): void {
    const { keepalive } = entry;
    if (keepalive !== undefined) keepalive.state = update(keepalive.state, this.deps.now());
  }

  private async unregister(entry: Entry): Promise<void> {
    const { connection, candidate, account } = entry;
    if (connection === undefined || candidate === undefined || entry.snapshot.state !== 'registered') return;
    const deps = { connection, ids: this.deps.ids, hash: md5, timeoutMs: UNREGISTER_TIMEOUT_MS };
    const result = await register({ account, candidate, expires: 0 }, deps);
    if (result.ok) this.note(account.id, 'logs.event.unregistered');
  }

  private dropConnection(entry: Entry): void {
    const { connection } = entry;
    entry.connection = undefined;
    this.endKeepalive(entry);
    connection?.close();
  }

  private clearTimer(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private dispatchRegistration(entry: Entry, event: RegistrationEvent): void {
    try {
      entry.snapshot = reduceRegistration(entry.snapshot, event);
      this.noteRegistration(entry, event);
    } catch (error) {
      log('warn', `registration ${event.type} ignored: ${String(error)}`);
    }
    this.emit();
  }

  private noteRegistration(entry: Entry, event: RegistrationEvent): void {
    const { account } = entry;
    if (event.type === 'register' || event.type === 'retry') {
      this.note(account.id, 'logs.event.registering', { params: { account: `${account.username}@${account.domain}` } });
    } else if (event.type === 'failed') {
      this.note(account.id, 'logs.event.failed', { level: 'warn', params: { reason: event.reason } });
    }
  }

  /* ------------------------------------------------------------ inbound */

  private onMessage(entry: Entry, message: SipRequest | SipResponse): void {
    if (entry.stopped) return;
    this.traceReceived(entry, message);
    if (!isResponse(message)) return this.onRequest(entry, message);
    this.learnMapping(entry, message);
    this.onResponse(entry, message);
  }

  /**
   * Every response carries the address the server sees (RFC 3581), not only a REGISTER answer, so the 100 Trying
   * of an INVITE is enough to correct an offer that went out before registration had reported it.
   */
  private learnMapping(entry: Entry, response: SipResponse): void {
    const { connection } = entry;
    if (connection === undefined) return;
    const before = connection.publicAddress;
    if (learnPublicAddress(connection, response)) this.noteMappedAddress(entry, before, connection.publicAddress);
    this.reofferStale(entry);
  }

  /** A confirmed call whose SDP names a host that is no longer our reachable one gets a fresh offer. */
  private reofferStale(entry: Entry): void {
    this.confirmedDialogs(entry)
      .filter((dialog) => dialog.advertised !== this.hostOf(dialog))
      .forEach((dialog) => this.reoffer(dialog));
  }

  private confirmedDialogs(entry: Entry): Dialog[] {
    return [...this.dialogs.values()].filter(
      (dialog) => dialog.entry === entry && dialog.stage === 'confirmed' && dialog.pending === undefined
    );
  }

  private reoffer(dialog: Dialog): void {
    dialog.contactOn = dialog.entry.connection;
    this.sendRequest(dialog, 'INVITE', this.sdpFor(dialog, dialog.direction)).catch(this.logSend);
  }

  /**
   * After the connection was replaced (dead flow, transport close, any registration failure), every confirmed
   * call may still name the old socket in its Contact, so the far
   * end would keep sending BYE and re-INVITE there. A re-INVITE on the new connection refreshes the remote
   * target (RFC 3261 section 12.2.1.1). One already sent for the same reason (a changed mapped address) is enough.
   */
  private recoverCalls(entry: Entry): void {
    this.confirmedDialogs(entry)
      .filter((dialog) => dialog.contactOn !== entry.connection)
      .forEach((dialog) => this.reoffer(dialog));
  }

  /** Registered yet no mapping reported: the server does not echo `received`, so say so rather than fail the call. */
  private warnIfUnmapped(entry: Entry, connection: SipConnection): void {
    if (connection.publicAddress !== undefined) return;
    this.note(entry.account.id, 'logs.event.natUnknown', { level: 'warn', params: { address: connection.localAddress.host } });
  }

  private onResponse(entry: Entry, response: SipResponse): void {
    if (isChallenge(response)) this.note(entry.account.id, 'logs.event.challenged');
    const dialog = this.dialogs.get(first(response.headers, 'call-id'));
    const cseq = inviteCseq(response);
    if (dialog === undefined || cseq === undefined) return;
    if (dialog.pending?.cseq === cseq) this.onInviteResponse(dialog, response);
    else if (response.status >= 200 && response.status < 300) this.onReinviteAnswered(dialog, response, cseq);
  }

  /** Also covers a retransmitted 2xx to the original INVITE, which must be acknowledged again. */
  private onReinviteAnswered(dialog: Dialog, response: SipResponse, cseq: number): void {
    this.sendAckTo(dialog, buildDialogRequest(dialog, 'ACK', cseq, this.deps.ids.newBranch()));
    if (response.body !== '') this.adoptMedia(dialog, response.body);
    log('info', `re-INVITE accepted for ${dialog.entry.account.id}`);
  }

  private onRequest(entry: Entry, request: SipRequest): void {
    const handlers: Readonly<Record<string, (e: Entry, r: SipRequest) => void>> = {
      INVITE: (e, r) => this.onInvite(e, r),
      ACK: (_e, r) => this.onAck(r),
      BYE: (e, r) => this.onBye(e, r),
      CANCEL: (e, r) => this.onCancel(e, r),
      OPTIONS: (e, r) => this.respond(e, r, 200, 'OK')
    };
    const handler = handlers[request.method] ?? ((e: Entry, r: SipRequest): void => this.respond(e, r, 405, 'Method Not Allowed'));
    handler(entry, request);
  }

  private onInvite(entry: Entry, request: SipRequest): void {
    const known = this.dialogs.get(first(request.headers, 'call-id'));
    if (known !== undefined) return this.onKnownInvite(known, request);
    const negotiated = negotiateBody(request.body);
    if (negotiated === undefined) return this.respond(entry, request, 488, 'Not Acceptable Here');
    this.acceptInvite(entry, request, negotiated);
  }

  private acceptInvite(entry: Entry, request: SipRequest, negotiated: Negotiated): void {
    const callId = first(request.headers, 'call-id');
    try {
      const remoteIdentity = identityOf(first(request.headers, 'from'));
      this.registry = incomingCall(this.registry, { id: callId, accountId: entry.account.id, remoteIdentity });
    } catch (error) {
      log('warn', `rejecting incoming call: ${String(error)}`);
      return this.respond(entry, request, 486, 'Busy Here');
    }
    const dialog = this.newInbound(entry, request, negotiated);
    this.dialogs.set(callId, dialog);
    this.reply(dialog, 180, 'Ringing').catch(this.logSend);
    this.emit();
  }

  private newInbound(entry: Entry, request: SipRequest, negotiated: Negotiated): Dialog {
    const from = first(request.headers, 'from');
    const contact = headerValue(request.headers, 'contact');
    return this.newDialog({
      entry,
      role: 'uas',
      callId: first(request.headers, 'call-id'),
      invite: request,
      localTag: this.deps.ids.newTag(),
      sdpSession: this.sessionId(),
      remoteHeader: from,
      target: contact === undefined ? uriOf(from) : stripBrackets(contact),
      routes: headerValues(request.headers, 'record-route'),
      direction: negotiated.direction,
      plan: negotiated.plan,
      rtpPort: 0
    });
  }

  /** A retransmission of the INVITE gets our last answer again; a higher CSeq is a re-INVITE. */
  private onKnownInvite(dialog: Dialog, request: SipRequest): void {
    const cseq = Number.parseInt(first(request.headers, 'cseq'), 10);
    if (cseq <= dialog.cseq || dialog.stage === 'early') {
      this.resendProvisionalOrFinal(dialog);
      return;
    }
    const negotiated = negotiateBody(request.body);
    if (negotiated === undefined) {
      this.reply(dialog, 488, 'Not Acceptable Here').catch(this.logSend);
      return;
    }
    this.adoptMedia(dialog, request.body);
    this.reply(dialog, 200, 'OK', this.sdpFor(dialog, negotiated.direction)).catch(this.logSend);
  }

  private resendProvisionalOrFinal(dialog: Dialog): void {
    const answered = dialog.stage !== 'early';
    const send = answered ? this.reply(dialog, 200, 'OK', this.sdpFor(dialog, dialog.direction)) : this.reply(dialog, 180, 'Ringing');
    send.catch(this.logSend);
  }

  private onAck(request: SipRequest): void {
    const dialog = this.dialogs.get(first(request.headers, 'call-id'));
    if (dialog === undefined || this.registry[dialog.callId]?.state !== 'connecting') return;
    if (!this.dispatchCall(dialog.callId, { type: 'connected' })) return;
    dialog.stage = 'confirmed';
    this.startMedia(dialog);
  }

  private onBye(entry: Entry, request: SipRequest): void {
    const callId = first(request.headers, 'call-id');
    if (!this.dialogs.has(callId)) return this.respond(entry, request, 481, 'Call/Transaction Does Not Exist');
    this.respond(entry, request, 200, 'OK');
    this.endRemote(callId);
  }

  private onCancel(entry: Entry, request: SipRequest): void {
    const callId = first(request.headers, 'call-id');
    const dialog = this.dialogs.get(callId);
    if (dialog === undefined) return this.respond(entry, request, 481, 'Call/Transaction Does Not Exist');
    this.respond(entry, request, 200, 'OK');
    this.reply(dialog, 487, 'Request Terminated').catch(this.logSend);
    this.endRemote(callId);
  }

  private endRemote(callId: string): void {
    const dialog = this.dialogs.get(callId);
    if (dialog !== undefined) this.releaseDialog(dialog);
    this.dispatchCall(callId, { type: 'remoteHangup' });
  }

  private endCallsOf(accountId: AccountId): void {
    for (const call of callsForAccount(this.registry, accountId)) {
      if (call.state !== 'ended') this.endRemote(call.id);
    }
  }

  /* ------------------------------------------------------------ outbound */

  private readonly logSend = (error: unknown): void => log('warn', `send failed: ${String(error)}`);

  private newDialog(base: DialogBase): Dialog {
    return {
      ...base,
      localHeader: localHeaderOf(base.entry, base.localTag),
      cseq: 1,
      stage: 'early',
      media: undefined,
      pending: undefined,
      setup: undefined,
      advertised: '',
      held: false,
      muted: false,
      cancelled: false,
      connectedAt: undefined,
      contactOn: base.entry.connection
    };
  }

  private respond(entry: Entry, request: SipRequest, status: number, reason: string): void {
    const reply = buildReply(request, status, reason, { toTag: this.deps.ids.newTag() });
    entry.connection?.send(reply).catch(this.logSend);
  }

  private async reply(dialog: Dialog, status: number, reason: string, body?: string): Promise<void> {
    const { connection } = dialog.entry;
    if (connection === undefined) return;
    const contact = status < 300 ? contactFor(dialog.entry, connection) : undefined;
    const options: ReplyOptions = {
      toTag: dialog.localTag,
      ...(contact === undefined ? {} : { contact }),
      ...(body === undefined ? {} : { body })
    };
    await connection.send(buildReply(dialog.invite, status, reason, options));
  }

  private async sendRequest(dialog: Dialog, method: string, body?: string): Promise<void> {
    const { connection } = dialog.entry;
    if (connection === undefined) return log('warn', `${method} not sent: no connection`);
    dialog.cseq += 1;
    await connection.send(buildDialogRequest(dialog, method, dialog.cseq, this.deps.ids.newBranch(), body));
  }

  private sendAckTo(dialog: Dialog, request: SipRequest): void {
    dialog.entry.connection?.send(request).catch(this.logSend);
  }

  private hostOf(dialog: Dialog): string {
    return this.hostOfEntry(dialog.entry);
  }

  private hostOfEntry(entry: Entry): string {
    return entry.connection === undefined ? '0.0.0.0' : reachableAt(entry.connection).host;
  }

  private requireDialog(callId: string): Dialog {
    const dialog = this.dialogs.get(callId);
    if (dialog === undefined) throw new Error(`unknown call: ${callId}`);
    return dialog;
  }

  private dispatchCall(callId: string, event: CallEvent): boolean {
    try {
      this.registry = applyCallEvent(this.registry, callId, event);
      this.markConnected(callId);
      this.dropSilentEnd(callId);
      return true;
    } catch (error) {
      log('warn', `call ${event.type} ignored: ${String(error)}`);
      return false;
    } finally {
      this.emit();
    }
  }

  /** An ended call with nothing to tell the user leaves no trace. */
  private dropSilentEnd(callId: string): void {
    if (this.registry[callId]?.state === 'ended' && this.tracks.get(callId)?.endReasonKey === undefined) {
      this.tracks.delete(callId);
    }
  }

  private markConnected(callId: string): void {
    const dialog = this.dialogs.get(callId);
    if (dialog !== undefined && dialog.connectedAt === undefined && this.registry[callId]?.state === 'active') {
      dialog.connectedAt = this.deps.now();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function uriOf(header: string): string {
  return stripBrackets(header.split(';')[0] ?? header);
}
