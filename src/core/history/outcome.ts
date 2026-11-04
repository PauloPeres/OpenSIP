import type { CallEvent } from '../sip/call';
import type { CallSession, CallState } from '../sip/types';
import type { CallOutcome, CallRecord } from './types';

/** What the engine knows at the moment a call enters `ended`. */
export interface FinishedCall {
  readonly direction: CallSession['direction'];
  /** The state the call was in just before the event that ended it. */
  readonly before: CallState;
  /** The event that ended it. */
  readonly event: CallEvent['type'];
  /** True when the call was ever active. */
  readonly reachedActive: boolean;
  /** True when the engine knows the call ended because something went wrong. */
  readonly failed: boolean;
  readonly endReasonKey?: string | undefined;
}

function inboundOutcome({ before, event }: FinishedCall): CallOutcome {
  if (before !== 'ringing') return 'failed';
  return event === 'reject' ? 'rejected' : 'missed';
}

/** Never active, so the only way the user ended it is by hanging up before an answer. */
function outboundOutcome({ event }: FinishedCall): CallOutcome {
  return event === 'hangup' ? 'cancelled' : 'failed';
}

/**
 * Anything that reached active is answered, however it ended. Otherwise a
 * recorded failure wins; then the direction decides who walked away.
 */
export function classifyOutcome(call: FinishedCall): CallOutcome {
  if (call.reachedActive) return 'answered';
  if (call.failed || call.endReasonKey !== undefined) return 'failed';
  return call.direction === 'inbound' ? inboundOutcome(call) : outboundOutcome(call);
}

export interface RecordInput extends FinishedCall {
  readonly call: Pick<CallSession, 'id' | 'accountId' | 'direction' | 'remoteIdentity'>;
  readonly startedAt: number;
  readonly connectedAt?: number | undefined;
  readonly endedAt: number;
}

export function recordFromCall(input: RecordInput): CallRecord {
  const { call, startedAt, connectedAt, endedAt, endReasonKey } = input;
  return {
    id: call.id,
    accountId: call.accountId,
    direction: call.direction,
    remoteIdentity: call.remoteIdentity,
    startedAt,
    ...(connectedAt === undefined ? {} : { connectedAt }),
    endedAt,
    outcome: classifyOutcome(input),
    ...(endReasonKey === undefined ? {} : { endReasonKey })
  };
}
