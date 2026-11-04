import { describe, expect, it } from 'vitest';
import { CallJournal } from '../../src/core/history';

const call = { id: 'c1', accountId: 'acc1', direction: 'outbound', remoteIdentity: 'sip:1001@pbx.test' } as const;
const step = (extra: Record<string, unknown>) => ({ callId: 'c1', before: 'connecting', after: 'active', event: 'connected', at: 0, ...extra }) as never;

describe('CallJournal', () => {
  it('writes nothing while a call is still going', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    expect(journal.observe(step({ at: 150 }))).toBeUndefined();
    expect(journal.observe(step({ before: 'active', after: 'held', event: 'hold', at: 160 }))).toBeUndefined();
  });

  it('writes one answered record with the time it connected, when the call ends', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    journal.observe(step({ at: 150 }));
    const record = journal.observe(step({ before: 'active', after: 'ended', event: 'hangup', at: 900 }));
    expect(record).toEqual({
      id: 'c1', accountId: 'acc1', direction: 'outbound', remoteIdentity: 'sip:1001@pbx.test',
      startedAt: 100, connectedAt: 150, endedAt: 900, outcome: 'answered'
    });
  });

  it('keeps the first connected time through hold and resume', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    journal.observe(step({ at: 150 }));
    journal.observe(step({ before: 'active', after: 'held', event: 'hold', at: 200 }));
    journal.observe(step({ before: 'held', after: 'active', event: 'resume', at: 300 }));
    const record = journal.observe(step({ before: 'active', after: 'ended', event: 'hangup', at: 900 }));
    expect(record?.connectedAt).toBe(150);
  });

  it('writes a cancelled record for an outbound hang-up before an answer', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    const record = journal.observe(step({ after: 'ended', event: 'hangup', at: 400 }));
    expect(record?.outcome).toBe('cancelled');
    expect(record).not.toHaveProperty('connectedAt');
  });

  it('writes a failed record when the engine marked the call failed', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    journal.markFailed('c1');
    expect(journal.observe(step({ after: 'ended', event: 'hangup', at: 400 }))?.outcome).toBe('failed');
  });

  it('carries the end reason it is given', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    const record = journal.observe(step({ after: 'ended', event: 'remoteHangup', at: 400, endReasonKey: 'calls.endReason.busy' }));
    expect(record).toMatchObject({ outcome: 'failed', endReasonKey: 'calls.endReason.busy' });
  });

  it('writes a record only once however often it is told the call ended', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    expect(journal.observe(step({ after: 'ended', event: 'hangup', at: 400 }))).toBeDefined();
    expect(journal.observe(step({ before: 'ended', after: 'ended', event: 'hangup', at: 500 }))).toBeUndefined();
  });

  it('does not end a call on a step that starts from ended', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    expect(journal.observe(step({ before: 'ended', after: 'ended', event: 'hangup', at: 500 }))).toBeUndefined();
    expect(journal.observe(step({ after: 'ended', event: 'hangup', at: 600 }))).toMatchObject({ endedAt: 600 });
  });

  it('leaves the optional fields out of the record when there are none', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    const record = journal.observe(step({ after: 'ended', event: 'hangup', at: 400 }));
    expect(Object.keys(record ?? {}).sort()).toEqual(['accountId', 'direction', 'endedAt', 'id', 'outcome', 'remoteIdentity', 'startedAt']);
  });

  it('ignores a call it never saw begin', () => {
    expect(new CallJournal().observe(step({ after: 'ended', event: 'hangup' }))).toBeUndefined();
  });

  it('ignores a failure mark for a call it never saw', () => {
    const journal = new CallJournal();
    expect(() => journal.markFailed('nope')).not.toThrow();
  });

  it('keeps calls apart', () => {
    const journal = new CallJournal();
    journal.begin(call, 100);
    journal.begin({ ...call, id: 'c2', direction: 'inbound', remoteIdentity: 'Alice' }, 200);
    const second = journal.observe(step({ callId: 'c2', before: 'ringing', after: 'ended', event: 'remoteHangup', at: 300 }));
    expect(second).toMatchObject({ id: 'c2', outcome: 'missed', startedAt: 200 });
    expect(journal.observe(step({ after: 'ended', event: 'hangup', at: 400 }))).toMatchObject({ id: 'c1', outcome: 'cancelled' });
  });
});
