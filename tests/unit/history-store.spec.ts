import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_ENTRIES,
  appendRecord,
  callDuration,
  clearHistory,
  countMissed,
  filterHistory,
  removeRecord
} from '../../src/core/history';
import type { CallRecord } from '../../src/core/history';

const record = (id: string, extra: Partial<CallRecord> = {}): CallRecord => ({
  id,
  accountId: 'acc1',
  direction: 'outbound',
  remoteIdentity: 'sip:1001@pbx.test',
  startedAt: 1_000,
  endedAt: 2_000,
  outcome: 'cancelled',
  ...extra
});

describe('MAX_HISTORY_ENTRIES', () => {
  it('is 500', () => {
    expect(MAX_HISTORY_ENTRIES).toBe(500);
  });
});

describe('appendRecord', () => {
  it('puts the newest record first', () => {
    const next = appendRecord([record('a')], record('b'));
    expect(next.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('starts a list from nothing', () => {
    expect(appendRecord([], record('a'))).toEqual([record('a')]);
  });

  it('does not change the list it was given', () => {
    const before = [record('a')];
    appendRecord(before, record('b'));
    expect(before.map((r) => r.id)).toEqual(['a']);
  });

  it('keeps exactly MAX_HISTORY_ENTRIES and drops the oldest', () => {
    const full = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => record(`r${MAX_HISTORY_ENTRIES - i}`));
    const next = appendRecord(full, record('new'));
    expect(next).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(next[0]?.id).toBe('new');
    expect(next.at(-1)?.id).toBe('r2');
    expect(next.some((r) => r.id === 'r1')).toBe(false);
  });

  it('does not drop anything one short of the cap', () => {
    const almost = Array.from({ length: MAX_HISTORY_ENTRIES - 1 }, (_, i) => record(`r${i}`));
    const next = appendRecord(almost, record('new'));
    expect(next).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(next.at(-1)?.id).toBe('r498');
  });

  it('replaces a record that has the same id instead of listing it twice', () => {
    const next = appendRecord([record('a', { outcome: 'failed' }), record('b')], record('a', { outcome: 'answered' }));
    expect(next.map((r) => r.id)).toEqual(['a', 'b']);
    expect(next[0]?.outcome).toBe('answered');
  });
});

describe('removeRecord', () => {
  it('removes only the record with that id', () => {
    expect(removeRecord([record('a'), record('b'), record('c')], 'b').map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('returns the same entries when the id is unknown', () => {
    expect(removeRecord([record('a')], 'zzz')).toEqual([record('a')]);
  });
});

describe('clearHistory', () => {
  it('is empty', () => {
    expect(clearHistory()).toEqual([]);
  });
});

describe('callDuration', () => {
  it('is the time between connecting and ending', () => {
    expect(callDuration(record('a', { connectedAt: 1_500, endedAt: 9_500, outcome: 'answered' }))).toBe(8_000);
  });

  it('is absent when the call never went active', () => {
    expect(callDuration(record('a'))).toBeUndefined();
  });

  it('is zero for a call that ended the instant it connected', () => {
    expect(callDuration(record('a', { connectedAt: 2_000, endedAt: 2_000, outcome: 'answered' }))).toBe(0);
  });

  it('never goes negative when the clock stepped back', () => {
    expect(callDuration(record('a', { connectedAt: 5_000, endedAt: 2_000, outcome: 'answered' }))).toBe(0);
  });
});

describe('filterHistory and countMissed', () => {
  const mixed = [record('a', { outcome: 'missed' }), record('b', { outcome: 'answered' }), record('c', { outcome: 'missed' }), record('d', { outcome: 'rejected' })];

  it('all keeps every record in order', () => {
    expect(filterHistory(mixed, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('missed keeps only missed calls, in order', () => {
    expect(filterHistory(mixed, 'missed').map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('counts the missed calls', () => {
    expect(countMissed(mixed)).toBe(2);
    expect(countMissed([])).toBe(0);
  });
});
