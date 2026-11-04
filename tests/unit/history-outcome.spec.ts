import { describe, expect, it } from 'vitest';
import { classifyOutcome, recordFromCall } from '../../src/core/history';
import type { FinishedCall } from '../../src/core/history';

const finished = (extra: Partial<FinishedCall> = {}): FinishedCall => ({
  direction: 'outbound',
  before: 'connecting',
  event: 'hangup',
  reachedActive: false,
  failed: false,
  ...extra
});

describe('classifyOutcome: anything that reached active is answered', () => {
  it.each(['hangup', 'remoteHangup'] as const)('outbound ended by %s', (event) => {
    expect(classifyOutcome(finished({ reachedActive: true, before: 'active', event }))).toBe('answered');
  });

  it('inbound ended from held', () => {
    expect(classifyOutcome(finished({ direction: 'inbound', reachedActive: true, before: 'held', event: 'remoteHangup' }))).toBe('answered');
  });

  it('even when a failure reason was recorded afterwards', () => {
    expect(classifyOutcome(finished({ reachedActive: true, before: 'active', endReasonKey: 'calls.endReason.busy', failed: true }))).toBe('answered');
  });
});

describe('classifyOutcome: inbound calls that never went active', () => {
  const inbound = (extra: Partial<FinishedCall>): FinishedCall => finished({ direction: 'inbound', before: 'ringing', ...extra });

  it('the caller gave up while it rang: missed', () => {
    expect(classifyOutcome(inbound({ event: 'remoteHangup' }))).toBe('missed');
  });

  it('the user rejected it while it rang: rejected', () => {
    expect(classifyOutcome(inbound({ event: 'reject' }))).toBe('rejected');
  });

  it('the user answered but it ended before audio was up: failed', () => {
    expect(classifyOutcome(inbound({ before: 'connecting', event: 'hangup' }))).toBe('failed');
    expect(classifyOutcome(inbound({ before: 'connecting', event: 'remoteHangup' }))).toBe('failed');
  });

  it('a call the engine marked as failed while it rang: failed', () => {
    expect(classifyOutcome(inbound({ event: 'remoteHangup', failed: true }))).toBe('failed');
  });
});

describe('classifyOutcome: outbound calls that never went active', () => {
  it('the user hung up before it was answered: cancelled', () => {
    expect(classifyOutcome(finished())).toBe('cancelled');
  });

  it('the far end ended it: failed', () => {
    expect(classifyOutcome(finished({ event: 'remoteHangup' }))).toBe('failed');
  });

  it('a hang-up that carries a failure reason: failed', () => {
    expect(classifyOutcome(finished({ endReasonKey: 'calls.endReason.setupTimeout' }))).toBe('failed');
  });

  it('a hang-up the engine marked as failed: failed', () => {
    expect(classifyOutcome(finished({ failed: true }))).toBe('failed');
  });

  it('a rejection reason on an outbound call is still a failure', () => {
    expect(classifyOutcome(finished({ event: 'remoteHangup', endReasonKey: 'calls.endReason.busy' }))).toBe('failed');
  });
});

describe('recordFromCall', () => {
  const call = { id: 'c1', accountId: 'acc1', direction: 'outbound', remoteIdentity: 'sip:1001@pbx.test' } as const;

  it('copies identity and timestamps and adds the outcome', () => {
    expect(recordFromCall({ call, startedAt: 10, endedAt: 99, ...finished() })).toEqual({
      id: 'c1',
      accountId: 'acc1',
      direction: 'outbound',
      remoteIdentity: 'sip:1001@pbx.test',
      startedAt: 10,
      endedAt: 99,
      outcome: 'cancelled'
    });
  });

  it('carries connectedAt and the end reason when there are some', () => {
    const record = recordFromCall({
      call,
      startedAt: 10,
      connectedAt: 40,
      endedAt: 99,
      ...finished({ reachedActive: true, before: 'active', endReasonKey: 'calls.endReason.busy' })
    });
    expect(record.connectedAt).toBe(40);
    expect(record.endReasonKey).toBe('calls.endReason.busy');
    expect(record.outcome).toBe('answered');
  });

  it('leaves the optional fields out entirely when absent', () => {
    const record = recordFromCall({ call, startedAt: 10, endedAt: 99, ...finished() });
    expect(Object.keys(record)).not.toContain('connectedAt');
    expect(Object.keys(record)).not.toContain('endReasonKey');
  });
});
