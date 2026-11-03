import { Registerer, RegistererState, SessionState, UserAgent, Web } from 'sip.js';
import type { Invitation } from 'sip.js';
import {
  activeCalls,
  applyCallEvent,
  emptyCallRegistry,
  incomingCall,
  initialRegistration,
  reduceRegistration
} from '@core/sip';
import type {
  AccountId,
  CallEvent,
  CallRegistry,
  CallSession,
  RegistrationEvent,
  RegistrationSnapshot,
  SipAccount
} from '@core/sip';
import { log } from './windows';

/**
 * Thin sip.js adapter. All state transitions are delegated to the pure reducers
 * in `@core/sip`; this class only translates library events and performs I/O.
 */

const MEDIA = { constraints: { audio: true, video: false } } as const;

interface Entry {
  readonly ua: UserAgent;
  readonly registerer: Registerer;
  snapshot: RegistrationSnapshot;
}

type Listener = () => void;

export class SipEngine {
  private readonly entries = new Map<AccountId, Entry>();
  private readonly invitations = new Map<string, Invitation>();
  private registry: CallRegistry = emptyCallRegistry;
  private readonly listeners = new Set<Listener>();

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

  async start(accounts: readonly SipAccount[]): Promise<void> {
    await Promise.all(accounts.map((account) => this.startAccount(account)));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stopAccount(id)));
  }

  async startAccount(account: SipAccount): Promise<void> {
    const ua = this.createUserAgent(account);
    const registerer = new Registerer(ua, { expires: account.registerExpires });
    const entry: Entry = { ua, registerer, snapshot: initialRegistration };
    this.entries.set(account.id, entry);
    registerer.stateChange.addListener((state) => this.onRegistererState(account.id, state));
    this.dispatchRegistration(account.id, { type: 'register' });
    await this.connect(account.id, entry);
  }

  async stopAccount(id: AccountId): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    await entry.registerer.unregister().catch((error: unknown) => log('warn', `unregister: ${String(error)}`));
    await entry.ua.stop().catch((error: unknown) => log('warn', `ua stop: ${String(error)}`));
    this.emit();
  }

  async answer(callId: string): Promise<void> {
    const invitation = this.requireInvitation(callId);
    this.dispatchCall(callId, { type: 'answer' });
    await invitation.accept({ sessionDescriptionHandlerOptions: MEDIA });
  }

  async reject(callId: string): Promise<void> {
    const invitation = this.requireInvitation(callId);
    this.dispatchCall(callId, { type: 'reject' });
    await invitation.reject();
  }

  async hangup(callId: string): Promise<void> {
    const invitation = this.requireInvitation(callId);
    const ringing = this.registry[callId]?.state === 'ringing';
    this.dispatchCall(callId, { type: ringing ? 'reject' : 'hangup' });
    await (ringing ? invitation.reject() : invitation.bye());
  }

  async hold(callId: string): Promise<void> {
    const invitation = this.requireInvitation(callId);
    this.dispatchCall(callId, { type: 'hold' });
    await invitation.invite({ sessionDescriptionHandlerModifiers: [Web.holdModifier] });
  }

  async resume(callId: string): Promise<void> {
    const invitation = this.requireInvitation(callId);
    this.dispatchCall(callId, { type: 'resume' });
    await invitation.invite({ sessionDescriptionHandlerOptions: MEDIA });
  }

  private createUserAgent(account: SipAccount): UserAgent {
    const uri = UserAgent.makeURI(account.uri);
    if (uri === undefined) throw new Error(`invalid SIP URI: ${account.uri}`);
    return new UserAgent({
      uri,
      transportOptions: { server: account.wsServer },
      authorizationUsername: account.username,
      authorizationPassword: account.password,
      displayName: account.displayName,
      sessionDescriptionHandlerFactoryOptions: MEDIA,
      delegate: { onInvite: (invitation) => this.onInvite(account.id, invitation) }
    });
  }

  private async connect(id: AccountId, entry: Entry): Promise<void> {
    try {
      await entry.ua.start();
      await entry.registerer.register({
        requestDelegate: { onReject: (response) => this.failRegistration(id, response.message.reasonPhrase) }
      });
    } catch (error) {
      this.failRegistration(id, String(error));
    }
  }

  private failRegistration(id: AccountId, reason: string | undefined): void {
    this.dispatchRegistration(id, { type: 'failed', reason: reason ?? '' });
  }

  private onRegistererState(id: AccountId, state: RegistererState): void {
    if (state === RegistererState.Registered) this.dispatchRegistration(id, { type: 'registered' });
    else if (state !== RegistererState.Initial) this.dispatchRegistration(id, { type: 'unregister' });
  }

  private dispatchRegistration(id: AccountId, event: RegistrationEvent): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    try {
      entry.snapshot = reduceRegistration(entry.snapshot, event);
    } catch (error) {
      log('warn', `registration ${event.type} ignored: ${String(error)}`);
    }
    this.emit();
  }

  private onInvite(accountId: AccountId, invitation: Invitation): void {
    const remoteIdentity = invitation.remoteIdentity.friendlyName;
    try {
      this.registry = incomingCall(this.registry, { id: invitation.id, accountId, remoteIdentity });
    } catch (error) {
      log('warn', `rejecting incoming call: ${String(error)}`);
      invitation.reject().catch((e: unknown) => log('warn', `reject: ${String(e)}`));
      return;
    }
    this.invitations.set(invitation.id, invitation);
    invitation.stateChange.addListener((state) => this.onSessionState(invitation.id, state));
    this.emit();
  }

  private onSessionState(callId: string, state: SessionState): void {
    if (state === SessionState.Established) this.dispatchCall(callId, { type: 'connected' });
    if (state === SessionState.Terminated) this.onTerminated(callId);
  }

  private onTerminated(callId: string): void {
    if (this.registry[callId]?.state !== 'ended') this.dispatchCall(callId, { type: 'remoteHangup' });
    this.invitations.delete(callId);
  }

  private dispatchCall(callId: string, event: CallEvent): void {
    try {
      this.registry = applyCallEvent(this.registry, callId, event);
    } catch (error) {
      log('warn', `call ${event.type} ignored: ${String(error)}`);
    }
    this.emit();
  }

  private requireInvitation(callId: string): Invitation {
    const invitation = this.invitations.get(callId);
    if (invitation === undefined) throw new Error(`unknown call: ${callId}`);
    return invitation;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
