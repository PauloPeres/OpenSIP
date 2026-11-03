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
  answerCall: 'opensip:call:answer',
  rejectCall: 'opensip:call:reject',
  hangupCall: 'opensip:call:hangup',
  holdCall: 'opensip:call:hold',
  resumeCall: 'opensip:call:resume',
  getLocale: 'opensip:locale:get',
  setLocale: 'opensip:locale:set',
  updateStatus: 'opensip:update:status'
} as const;

export interface AccountView {
  readonly account: SipAccount;
  readonly registration: RegistrationSnapshot;
  /** The transport discovered (or configured) for this account, once known. */
  readonly transport?: SipTransport;
}

export interface AppSnapshot {
  readonly accounts: readonly AccountView[];
  readonly calls: readonly CallSession[];
  readonly locale: Locale;
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
  answerCall(callId: string): Promise<void>;
  rejectCall(callId: string): Promise<void>;
  hangupCall(callId: string): Promise<void>;
  holdCall(callId: string): Promise<void>;
  resumeCall(callId: string): Promise<void>;
  getLocale(): Promise<Locale>;
  setLocale(locale: Locale): Promise<Locale>;
  onSnapshot(cb: (snapshot: AppSnapshot) => void): Unsubscribe;
  onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
}

declare global {
  interface Window {
    readonly opensip: OpenSipApi;
  }
}
