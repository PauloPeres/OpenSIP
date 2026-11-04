import type { AccountId, CallDirection } from '../sip/types';

export type CallOutcome = 'answered' | 'missed' | 'rejected' | 'cancelled' | 'failed';

/**
 * One finished call. Duration is deliberately not a field: it is derived from
 * the timestamps (see callDuration), so it cannot disagree with them.
 */
export interface CallRecord {
  readonly id: string;
  readonly accountId: AccountId;
  readonly direction: CallDirection;
  /** As dialled, or as presented to us. */
  readonly remoteIdentity: string;
  readonly startedAt: number;
  /** Absent when the call never went active. */
  readonly connectedAt?: number;
  readonly endedAt: number;
  readonly outcome: CallOutcome;
  /** i18n key, when there is one worth showing. */
  readonly endReasonKey?: string;
}

export const MAX_HISTORY_ENTRIES = 500;

export const CALL_OUTCOMES: readonly CallOutcome[] = ['answered', 'missed', 'rejected', 'cancelled', 'failed'];
