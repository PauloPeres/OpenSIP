export type AccountId = string;

export interface SipAccountInput {
  readonly displayName: string;
  readonly username: string;
  readonly password: string;
  readonly domain: string;
  /** Optional manual override (e.g. tcp://pbx:5060); absent means discover the transport. */
  readonly serverUri?: string;
  readonly registerExpires?: number;
  /** Whether the account is registered; absent means on. Not part of the account's identity. */
  readonly enabled?: boolean;
}

export interface SipAccount extends SipAccountInput {
  readonly id: AccountId;
  readonly registerExpires: number;
  readonly enabled: boolean;
  readonly uri: string;
}

export type RegistrationState = 'offline' | 'registering' | 'registered' | 'failed';
export type CallState = 'ringing' | 'connecting' | 'active' | 'held' | 'ended';
export type CallDirection = 'inbound' | 'outbound';

export interface CallSession {
  readonly id: string;
  readonly accountId: AccountId;
  readonly remoteIdentity: string;
  readonly direction: CallDirection;
  readonly state: CallState;
}

export interface ValidationIssue {
  readonly field: keyof SipAccountInput;
  readonly messageKey: string;
}
