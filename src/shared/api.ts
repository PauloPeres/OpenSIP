import type { LogEntry } from '@core/diagnostics';
import type { Locale } from '@core/i18n';
import type {
  AccountId,
  CallSession,
  RegistrationSnapshot,
  SipAccount,
  SipAccountInput,
  SipTransport,
  ValidationIssue
} from '@core/sip';

export const IPC = {
  listSnapshot: 'opensip:snapshot:get',
  subscribe: 'opensip:snapshot:changed',
  saveAccount: 'opensip:account:save',
  deleteAccount: 'opensip:account:delete',
  setAccountEnabled: 'opensip:account:enabled',
  answerCall: 'opensip:call:answer',
  rejectCall: 'opensip:call:reject',
  hangupCall: 'opensip:call:hangup',
  holdCall: 'opensip:call:hold',
  resumeCall: 'opensip:call:resume',
  dial: 'opensip:call:dial',
  sendDtmf: 'opensip:call:dtmf',
  setMuted: 'opensip:call:mute',
  getLocale: 'opensip:locale:get',
  setLocale: 'opensip:locale:set',
  setDebugLogging: 'opensip:logs:debug',
  clearLogs: 'opensip:logs:clear',
  openSystemSettings: 'opensip:system:settings',
  micPermission: 'opensip:system:mic',
  updateStatus: 'opensip:update:status'
} as const;

/** What the operating system says about microphone access (Electron's `getMediaAccessStatus`). */
export type MicAccess = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface AccountView {
  readonly account: SipAccount;
  readonly registration: RegistrationSnapshot;
  /** The transport discovered (or configured) for this account, once known. */
  readonly transport?: SipTransport;
  /** What the registrar reported about other devices holding this same account. */
  readonly sharing?: AccountSharing;
}

/** Live audio counters for one call, so the UI can show that media is really flowing. */
export interface MediaStats {
  readonly rxPackets: number;
  readonly txPackets: number;
  readonly lostPackets: number;
  readonly muted: boolean;
}

export interface CallView {
  readonly call: CallSession;
  /** Wall-clock ms when the call became active; absent while it is not. */
  readonly connectedAt?: number;
  readonly media?: MediaStats;
  /** i18n key for what the call is doing right now, e.g. 'calls.progress.ringing'. */
  readonly progress?: string;
  /** i18n key explaining why the call ended, when the user should be told. */
  readonly endReasonKey?: string;
}

/**
 * A REGISTER 200 OK lists every contact bound to the address of record, so it
 * tells us whether another device is logged in as this account — and whether
 * our own binding survived. A registration that was silently replaced stops
 * receiving calls without reporting any error, which is worth saying out loud.
 */
export interface AccountSharing {
  /** Bindings for this account that are not ours. */
  readonly others: number;
  /** True when our own contact is absent from the server's binding list. */
  readonly displaced: boolean;
}

export interface AppSnapshot {
  readonly accounts: readonly AccountView[];
  readonly calls: readonly CallView[];
  readonly locale: Locale;
  /** Oldest first, capped at DEFAULT_LOG_CAPACITY entries. */
  readonly logs: readonly LogEntry[];
  readonly debugLogging: boolean;
}

export type DialResult =
  | { readonly ok: true; readonly callId: string }
  | { readonly ok: false; readonly errorKey: string };

/** DTMF digits accepted by sendDtmf (RFC 4733 events 0-15). */
export const DTMF_DIGITS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'
] as const;
export type DtmfDigit = (typeof DTMF_DIGITS)[number];

/** Boundary check: only these sixteen characters may ever reach an RTP stream. */
export function isDtmfDigit(value: unknown): value is DtmfDigit {
  return typeof value === 'string' && (DTMF_DIGITS as readonly string[]).includes(value);
}

export type UpdateStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'upToDate' }
  | { readonly kind: 'error' };

export type AccountDraft = SipAccountInput & { readonly id?: AccountId };

export type SaveAccountResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export type Unsubscribe = () => void;

export interface OpenSipApi {
  getSnapshot(): Promise<AppSnapshot>;
  saveAccount(input: AccountDraft): Promise<SaveAccountResult>;
  deleteAccount(id: AccountId): Promise<void>;
  /** Turns an account on or off; off unregisters now and persists across restarts. */
  setAccountEnabled(id: AccountId, enabled: boolean): Promise<void>;
  answerCall(callId: string): Promise<void>;
  rejectCall(callId: string): Promise<void>;
  hangupCall(callId: string): Promise<void>;
  holdCall(callId: string): Promise<void>;
  resumeCall(callId: string): Promise<void>;
  /** Places an outbound call from `accountId` to an extension or full SIP URI. */
  dial(accountId: AccountId, target: string): Promise<DialResult>;
  sendDtmf(callId: string, digit: DtmfDigit): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  getLocale(): Promise<Locale>;
  setLocale(locale: Locale): Promise<Locale>;
  /** Turns raw SIP message capture on or off; returns the resulting state. */
  setDebugLogging(enabled: boolean): Promise<boolean>;
  clearLogs(): Promise<void>;
  /** Opens the OS microphone privacy pane. Takes no argument: the target is fixed in the main process. */
  openSystemSettings(): Promise<void>;
  /** The OS's microphone grant. Takes no argument: ground truth the renderer cannot see itself. */
  micPermission(): Promise<MicAccess>;
  onSnapshot(cb: (snapshot: AppSnapshot) => void): Unsubscribe;
  onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
}

declare global {
  interface Window {
    readonly opensip: OpenSipApi;
  }
}
