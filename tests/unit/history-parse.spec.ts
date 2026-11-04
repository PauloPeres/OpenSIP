import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_ENTRIES, parseHistory } from '../../src/core/history';

const valid = {
  id: 'a',
  accountId: 'acc1',
  direction: 'inbound',
  remoteIdentity: 'Alice',
  startedAt: 1,
  connectedAt: 2,
  endedAt: 3,
  outcome: 'answered',
  endReasonKey: 'calls.endReason.busy'
};

describe('parseHistory', () => {
  it.each([undefined, null, 'x', 7, {}, true])('starts empty for %s', (value) => {
    expect(parseHistory(value)).toEqual([]);
  });

  it('keeps a valid record, field for field', () => {
    expect(parseHistory([valid])).toEqual([valid]);
  });

  it('accepts a record without the optional fields', () => {
    const bare: Record<string, unknown> = { ...valid };
    delete bare['connectedAt'];
    delete bare['endReasonKey'];
    expect(parseHistory([bare])).toStrictEqual([bare]);
  });

  it('treats an optional field that is present but undefined as absent', () => {
    const [record] = parseHistory([{ ...valid, connectedAt: undefined, endReasonKey: undefined }]);
    expect(Object.keys(record ?? {})).not.toContain('connectedAt');
    expect(Object.keys(record ?? {})).not.toContain('endReasonKey');
  });

  it('drops fields it does not know', () => {
    expect(parseHistory([{ ...valid, duration: 5, extra: 'x' }])).toEqual([valid]);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no id', { ...valid, id: undefined }],
    ['an empty id', { ...valid, id: '' }],
    ['a numeric id', { ...valid, id: 5 }],
    ['a numeric account', { ...valid, accountId: 5 }],
    ['a bad direction', { ...valid, direction: 'sideways' }],
    ['a numeric identity', { ...valid, remoteIdentity: 5 }],
    ['a string startedAt', { ...valid, startedAt: '1' }],
    ['an infinite startedAt', { ...valid, startedAt: Infinity }],
    ['a NaN endedAt', { ...valid, endedAt: Number.NaN }],
    ['a string connectedAt', { ...valid, connectedAt: '2' }],
    ['a bad outcome', { ...valid, outcome: 'won' }],
    ['a numeric end reason', { ...valid, endReasonKey: 5 }]
  ])('skips a record with %s and keeps the rest', (_name, bad) => {
    expect(parseHistory([bad, valid])).toEqual([valid]);
  });

  it('accepts every direction and outcome', () => {
    const outcomes = ['answered', 'missed', 'rejected', 'cancelled', 'failed'];
    const rows = outcomes.flatMap((outcome) =>
      ['inbound', 'outbound'].map((direction) => ({ ...valid, id: `${outcome}-${direction}`, outcome, direction }))
    );
    expect(parseHistory(rows)).toHaveLength(10);
  });

  it('keeps the first of two records that share an id', () => {
    expect(parseHistory([{ ...valid, remoteIdentity: 'first' }, { ...valid, remoteIdentity: 'second' }])).toEqual([
      { ...valid, remoteIdentity: 'first' }
    ]);
  });

  it('never returns more than the cap, keeping the front of the list', () => {
    const rows = Array.from({ length: MAX_HISTORY_ENTRIES + 20 }, (_, i) => ({ ...valid, id: `r${i}` }));
    const parsed = parseHistory(rows);
    expect(parsed).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(parsed[0]?.id).toBe('r0');
    expect(parsed.at(-1)?.id).toBe(`r${MAX_HISTORY_ENTRIES - 1}`);
  });
});
