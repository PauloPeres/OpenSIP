import type { CallEvent } from '../sip/call';
import type { CallSession, CallState } from '../sip/types';
import { recordFromCall } from './outcome';
import type { CallRecord } from './types';

interface OpenCall {
  readonly call: Pick<CallSession, 'id' | 'accountId' | 'direction' | 'remoteIdentity'>;
  readonly startedAt: number;
  connectedAt: number | undefined;
  failed: boolean;
}

export interface CallStep {
  readonly callId: string;
  readonly before: CallState;
  readonly after: CallState;
  readonly event: CallEvent['type'];
  readonly at: number;
  readonly endReasonKey?: string | undefined;
}

/**
 * Follows calls from their first moment to their last and hands back one
 * record, once, when a call ends. It holds no I/O: the engine feeds it.
 */
export class CallJournal {
  private readonly open = new Map<string, OpenCall>();

  begin(call: OpenCall['call'], at: number): void {
    this.open.set(call.id, { call, startedAt: at, connectedAt: undefined, failed: false });
  }

  markFailed(callId: string): void {
    const entry = this.open.get(callId);
    if (entry !== undefined) entry.failed = true;
  }

  observe(step: CallStep): CallRecord | undefined {
    const entry = this.open.get(step.callId);
    if (entry === undefined) return undefined;
    if (step.after === 'active' && entry.connectedAt === undefined) entry.connectedAt = step.at;
    if (step.after !== 'ended' || step.before === 'ended') return undefined;
    this.open.delete(step.callId);
    return this.finish(entry, step);
  }

  private finish(entry: OpenCall, step: CallStep): CallRecord {
    return recordFromCall({
      call: entry.call,
      startedAt: entry.startedAt,
      connectedAt: entry.connectedAt,
      endedAt: step.at,
      direction: entry.call.direction,
      before: step.before,
      event: step.event,
      reachedActive: entry.connectedAt !== undefined,
      failed: entry.failed,
      endReasonKey: step.endReasonKey
    });
  }
}
