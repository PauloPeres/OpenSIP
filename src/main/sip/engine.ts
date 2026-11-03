/*
 * Native SIP engine (replaces the sip.js adapter).
 *
 * SCOPE OF THIS MILESTONE: signalling only. Registration, inbound INVITE/BYE/
 * CANCEL handling and answer/reject/hangup/hold/resume work at the SIP level.
 * RTP IS THE NEXT MILESTONE: the SDP we send advertises PCMU/8000 sendrecv on a
 * placeholder port that nothing reads, so answering a call establishes
 * signalling only. NO AUDIO FLOWS.
 *
 * All registration and call state transitions go through the pure reducers in
 * `@core/sip`; this file only translates wire events into reducer events and
 * performs I/O. Invalid transitions are logged, never thrown at the user.
 */
import { createHash } from 'node:crypto';
import {
  TRANSPORT_ERROR_KEYS,
  activeCalls,
  applyCallEvent,
  callsForAccount,
  canRetry,
  emptyCallRegistry,
  headerValue,
  headerValues,
  incomingCall,
  initialRegistration,
  isResponse,
  parseUri,
  reduceRegistration,
  withHeader
} from '@core/sip';
import type {
  AccountId,
  CallEvent,
  CallRegistry,
  CallSession,
  RegistrationEvent,
  RegistrationSnapshot,
  SipAccount,
  SipHeaders,
  SipRequest,
  SipResponse,
  TransportCandidate
} from '@core/sip';
import { log } from '../windows';
import { openConnection } from './connection';
import type { SipConnection } from './connection';
import { defaultIdFactory } from './ids';
import type { IdFactory } from './ids';
import { createProbeDeps, discoverTransport } from './prober';
import type { ProbeDeps } from './prober';
import { USER_AGENT, register } from './registrar';

const REFRESH_FRACTION = 0.9;
const MIN_REFRESH_MS = 5_000;
const RETRY_DELAY_MS = 30_000;
const MAX_RETRIES = 3;
const UNREGISTER_TIMEOUT_MS = 1_500;
/** Placeholder: no RTP socket exists yet (see file header). */
const RTP_PLACEHOLDER_PORT = 40_000;
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS';

const md5 = (input: string): string => createHash('md5').update(input).digest('hex');

type Listener = () => void;
type Timer = ReturnType<typeof setTimeout>;
type Direction = 'sendrecv' | 'sendonly';

export interface EngineDeps {
  readonly probe: ProbeDeps;
  readonly ids: IdFactory;
  readonly open: typeof openConnection;
}

interface Entry {
  readonly account: SipAccount;
  snapshot: RegistrationSnapshot;
  candidate: TransportCandidate | undefined;
  connection: SipConnection | undefined;
  timer: Timer | undefined;
  stopped: boolean;
}

interface Dialog {
  readonly entry: Entry;
  readonly invite: SipRequest;
  readonly toTag: string;
  cseq: number;
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

function buildSdp(host: string, direction: Direction): string {
  const family = host.includes(':') ? 'IP6' : 'IP4';
  return [
    'v=0',
    `o=opensip 0 0 IN ${family} ${host}`,
    's=OpenSIP',
    `c=IN ${family} ${host}`,
    't=0 0',
    `m=audio ${RTP_PLACEHOLDER_PORT} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    `a=${direction}`,
    ''
  ].join('\r\n');
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

const stripBrackets = (contact: string): string => (/<([^>]+)>/.exec(contact)?.[1] ?? contact).split(';')[0] ?? contact;

function dialogHeaders(dialog: Dialog, cseq: string, branch: string): SipHeaders {
  const { entry, invite } = dialog;
  const connection = entry.connection as SipConnection;
  const local = connection.localAddress;
  const transport = connection.candidate.transport.toUpperCase();
  return {
    via: [`SIP/2.0/${transport} ${local.host}:${local.port};branch=${branch};rport`],
    'max-forwards': ['70'],
    route: headerValues(invite.headers, 'record-route'),
    from: [`<${entry.account.uri}>;tag=${dialog.toTag}`],
    to: [first(invite.headers, 'from')],
    'call-id': [first(invite.headers, 'call-id')],
    cseq: [cseq],
    contact: [contactFor(entry, connection)],
    'user-agent': [USER_AGENT]
  };
}

function buildDialogRequest(
  dialog: Dialog,
  method: string,
  cseq: number,
  ids: IdFactory,
  body?: string
): SipRequest {
  const uri = stripBrackets(first(dialog.invite.headers, 'contact'));
  const headers = dialogHeaders(dialog, `${cseq} ${method}`, ids.newBranch());
  const typed = body === undefined ? headers : withHeader(headers, 'content-type', 'application/sdp');
  return { kind: 'request', method, uri, headers: typed, body: body ?? '' };
}

/* ---------------------------------------------------------------- engine */

const defaultDeps = (): EngineDeps => ({
  probe: createProbeDeps(),
  ids: defaultIdFactory,
  open: openConnection
});

const technical = (error: unknown): string =>
  (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.message : String(error));

export class SipEngine {
  private readonly entries = new Map<AccountId, Entry>();
  private readonly dialogs = new Map<string, Dialog>();
  private registry: CallRegistry = emptyCallRegistry;
  private readonly listeners = new Set<Listener>();
  private readonly deps: EngineDeps;

  constructor(deps: Partial<EngineDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCalls(): readonly CallSession[] {
    return activeCalls(this.registry);
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
  }

  /** Returns once the account is registering; discovery and REGISTER continue in the background. */
  async startAccount(account: SipAccount): Promise<void> {
    await this.stopAccount(account.id);
    const entry: Entry = {
      account,
      snapshot: initialRegistration,
      candidate: undefined,
      connection: undefined,
      timer: undefined,
      stopped: false
    };
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
    this.dropConnection(entry);
    this.emit();
  }

  async answer(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'answer' })) return;
    await this.reply(dialog, 200, 'OK', buildSdp(this.hostOf(dialog), 'sendrecv'));
  }

  async reject(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'reject' })) return;
    this.dialogs.delete(callId);
    await this.reply(dialog, 603, 'Decline');
  }

  async hangup(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    const ringing = this.registry[callId]?.state === 'ringing';
    if (!this.dispatchCall(callId, { type: ringing ? 'reject' : 'hangup' })) return;
    this.dialogs.delete(callId);
    if (ringing) await this.reply(dialog, 603, 'Decline');
    else await this.sendRequest(dialog, 'BYE');
  }

  async hold(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'hold' })) return;
    await this.sendRequest(dialog, 'INVITE', buildSdp(this.hostOf(dialog), 'sendonly'));
  }

  async resume(callId: string): Promise<void> {
    const dialog = this.requireDialog(callId);
    if (!this.dispatchCall(callId, { type: 'resume' })) return;
    await this.sendRequest(dialog, 'INVITE', buildSdp(this.hostOf(dialog), 'sendrecv'));
  }

  /* ------------------------------------------------------- registration */

  private async run(entry: Entry): Promise<void> {
    try {
      const { domain, serverUri } = entry.account;
      const params = serverUri === undefined ? { domain } : { domain, manualUri: serverUri };
      const { candidate } = await discoverTransport(params, this.deps.probe);
      if (entry.stopped) return;
      entry.candidate = candidate;
      this.emit();
      await this.attach(entry, await this.deps.open(candidate));
    } catch (error) {
      this.fail(entry, this.failureKey(error), true);
    }
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
    entry.connection = connection;
    connection.onMessage((message) => this.onMessage(entry, message));
    connection.onClose((reason) => this.onClosed(entry, connection, reason));
    await this.refresh(entry);
  }

  private async refresh(entry: Entry): Promise<void> {
    const { connection, candidate, account } = entry;
    if (connection === undefined || candidate === undefined) return;
    const params = { account, candidate, expires: account.registerExpires };
    const result = await register(params, { connection, ids: this.deps.ids, hash: md5 });
    if (entry.stopped || entry.connection !== connection) return;
    if (!result.ok) return this.fail(entry, result.errorKey, result.status === 408);
    if (entry.snapshot.state === 'registering') this.dispatchRegistration(entry, { type: 'registered' });
    const delay = Math.max(MIN_REFRESH_MS, Math.floor(result.expiresIn * REFRESH_FRACTION * 1000));
    entry.timer = setTimeout(() => void this.refresh(entry), delay);
  }

  private fail(entry: Entry, reason: string, retryable: boolean): void {
    if (entry.stopped) return;
    this.clearTimer(entry);
    this.dropConnection(entry);
    this.dispatchRegistration(entry, { type: 'failed', reason });
    if (retryable && canRetry(entry.snapshot, MAX_RETRIES)) {
      entry.timer = setTimeout(() => this.retry(entry), RETRY_DELAY_MS);
    }
  }

  private retry(entry: Entry): void {
    if (entry.stopped) return;
    this.dispatchRegistration(entry, { type: 'retry' });
    void this.run(entry);
  }

  private onClosed(entry: Entry, connection: SipConnection, reason: string): void {
    if (entry.stopped || entry.connection !== connection) return;
    log('warn', `connection closed: ${reason}`);
    this.fail(entry, reason, true);
  }

  private async unregister(entry: Entry): Promise<void> {
    const { connection, candidate, account } = entry;
    if (connection === undefined || candidate === undefined || entry.snapshot.state !== 'registered') return;
    const deps = { connection, ids: this.deps.ids, hash: md5, timeoutMs: UNREGISTER_TIMEOUT_MS };
    await register({ account, candidate, expires: 0 }, deps);
  }

  private dropConnection(entry: Entry): void {
    const { connection } = entry;
    entry.connection = undefined;
    connection?.close();
    this.endCallsOf(entry.account.id);
  }

  private clearTimer(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private dispatchRegistration(entry: Entry, event: RegistrationEvent): void {
    try {
      entry.snapshot = reduceRegistration(entry.snapshot, event);
    } catch (error) {
      log('warn', `registration ${event.type} ignored: ${String(error)}`);
    }
    this.emit();
  }

  /* ------------------------------------------------------------ inbound */

  private onMessage(entry: Entry, message: SipRequest | SipResponse): void {
    if (entry.stopped) return;
    if (isResponse(message)) this.onResponse(entry, message);
    else this.onRequest(entry, message);
  }

  private onResponse(entry: Entry, response: SipResponse): void {
    const callId = first(response.headers, 'call-id');
    const dialog = this.dialogs.get(callId);
    const cseq = first(response.headers, 'cseq');
    if (dialog === undefined || !cseq.endsWith(' INVITE') || response.status < 200 || response.status > 299) return;
    void this.sendAck(dialog, Number.parseInt(cseq, 10)).catch((e: unknown) => log('warn', `ack: ${String(e)}`));
    log('info', `re-INVITE accepted for ${entry.account.id}`);
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
    const callId = first(request.headers, 'call-id');
    const known = this.dialogs.get(callId);
    if (known !== undefined) {
      this.reply(known, 200, 'OK', buildSdp(this.hostOf(known), 'sendrecv')).catch(this.logSend);
      return;
    }
    try {
      const remoteIdentity = identityOf(first(request.headers, 'from'));
      this.registry = incomingCall(this.registry, { id: callId, accountId: entry.account.id, remoteIdentity });
    } catch (error) {
      log('warn', `rejecting incoming call: ${String(error)}`);
      this.respond(entry, request, 486, 'Busy Here');
      return;
    }
    const dialog: Dialog = { entry, invite: request, toTag: this.deps.ids.newTag(), cseq: 1 };
    this.dialogs.set(callId, dialog);
    this.reply(dialog, 180, 'Ringing').catch(this.logSend);
    this.emit();
  }

  private onAck(request: SipRequest): void {
    const callId = first(request.headers, 'call-id');
    if (this.registry[callId]?.state === 'connecting') this.dispatchCall(callId, { type: 'connected' });
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
    this.dialogs.delete(callId);
    this.dispatchCall(callId, { type: 'remoteHangup' });
  }

  private endCallsOf(accountId: AccountId): void {
    for (const call of callsForAccount(this.registry, accountId)) {
      if (call.state !== 'ended') this.endRemote(call.id);
    }
  }

  /* ------------------------------------------------------------ outbound */

  private readonly logSend = (error: unknown): void => log('warn', `send failed: ${String(error)}`);

  private respond(entry: Entry, request: SipRequest, status: number, reason: string): void {
    const reply = buildReply(request, status, reason, { toTag: this.deps.ids.newTag() });
    entry.connection?.send(reply).catch(this.logSend);
  }

  private async reply(dialog: Dialog, status: number, reason: string, body?: string): Promise<void> {
    const { connection } = dialog.entry;
    if (connection === undefined) return;
    const contact = status < 300 ? contactFor(dialog.entry, connection) : undefined;
    const options: ReplyOptions = {
      toTag: dialog.toTag,
      ...(contact === undefined ? {} : { contact }),
      ...(body === undefined ? {} : { body })
    };
    await connection.send(buildReply(dialog.invite, status, reason, options));
  }

  private async sendRequest(dialog: Dialog, method: string, body?: string): Promise<void> {
    dialog.cseq += 1;
    const request = buildDialogRequest(dialog, method, dialog.cseq, this.deps.ids, body);
    await dialog.entry.connection?.send(request);
  }

  private async sendAck(dialog: Dialog, cseq: number): Promise<void> {
    await dialog.entry.connection?.send(buildDialogRequest(dialog, 'ACK', cseq, this.deps.ids));
  }

  private hostOf(dialog: Dialog): string {
    const connection = dialog.entry.connection;
    return connection === undefined ? '0.0.0.0' : reachableAt(connection).host;
  }

  private requireDialog(callId: string): Dialog {
    const dialog = this.dialogs.get(callId);
    if (dialog === undefined) throw new Error(`unknown call: ${callId}`);
    return dialog;
  }

  private dispatchCall(callId: string, event: CallEvent): boolean {
    try {
      this.registry = applyCallEvent(this.registry, callId, event);
      return true;
    } catch (error) {
      log('warn', `call ${event.type} ignored: ${String(error)}`);
      return false;
    } finally {
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
