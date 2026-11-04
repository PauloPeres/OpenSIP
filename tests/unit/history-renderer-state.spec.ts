import { describe, expect, it } from 'vitest';
import type { CallRecord } from '../../src/core/history';
import { planRedial } from '../../src/renderer/src/state/historyRedial';
import { dayLabel, dayStart, groupByDay, timeLabel } from '../../src/renderer/src/state/historyTime';
import type { AccountView, CallView } from '../../src/shared/api';

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime();
const record = (id: string, endedAt: number, extra: Partial<CallRecord> = {}): CallRecord => ({
  id, accountId: 'a1', direction: 'outbound', remoteIdentity: 'sip:1001@pbx.test', startedAt: endedAt - 1000, endedAt, outcome: 'cancelled', ...extra
});

describe('day grouping', () => {
  it('starts a day at local midnight', () => {
    expect(dayStart(at(2026, 10, 4, 15))).toBe(at(2026, 10, 4, 0));
  });

  it('groups consecutive records of one day and keeps the order', () => {
    const groups = groupByDay([record('a', at(2026, 10, 4, 15)), record('b', at(2026, 10, 4, 9)), record('c', at(2026, 10, 3, 22))]);
    expect(groups.map((g) => g.records.map((r) => r.id))).toEqual([['a', 'b'], ['c']]);
    expect(groups[0]?.day).toBe(at(2026, 10, 4, 0));
  });

  it('has no groups for no records', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('labels follow the active locale', () => {
  const now = at(2026, 10, 4, 15);

  it('says today and yesterday with Intl', () => {
    expect(dayLabel('en', dayStart(now), now)).toBe('today');
    expect(dayLabel('en', dayStart(now) - 86_400_000, now)).toBe('yesterday');
    expect(dayLabel('pt-BR', dayStart(now), now)).toBe('hoje');
    expect(dayLabel('pt-BR', dayStart(now) - 86_400_000, now)).toBe('ontem');
  });

  it('writes older days as dates, with the year only when it differs', () => {
    expect(dayLabel('en', at(2026, 10, 1, 0), now)).toBe('Sunday, November 1');
    expect(dayLabel('en', at(2025, 11, 25, 0), now)).toBe('Thursday, December 25, 2025');
    expect(dayLabel('pt-BR', at(2026, 10, 1, 0), now)).toContain('novembro');
  });

  it('formats the time of day per locale', () => {
    expect(timeLabel('en', at(2026, 10, 4, 15))).toMatch(/3:00\s?PM/);
    expect(timeLabel('pt-BR', at(2026, 10, 4, 15))).toBe('15:00');
  });
});

const view = (id: string, state: AccountView['registration']['state'], enabled = true): AccountView =>
  ({ account: { id, enabled }, registration: { state } }) as unknown as AccountView;

describe('planRedial', () => {
  const registered = [view('a1', 'registered'), view('a2', 'registered')];

  it('dials the same target from the account the call used', () => {
    expect(planRedial(record('x', 1), registered, [])).toEqual({ ok: true, accountId: 'a1', target: 'sip:1001@pbx.test' });
  });

  it('falls back to another registered account', () => {
    expect(planRedial(record('x', 1), [view('a1', 'failed'), view('a2', 'registered')], [])).toMatchObject({ ok: true, accountId: 'a2' });
    expect(planRedial(record('x', 1), [view('a1', 'registered', false), view('a2', 'registered')], [])).toMatchObject({ accountId: 'a2' });
  });

  it('says why when nothing is registered', () => {
    expect(planRedial(record('x', 1), [view('a1', 'offline')], [])).toEqual({ ok: false, errorKey: 'calls.error.noAccount' });
  });

  it('says why when the caller is anonymous or only a name', () => {
    const anonymous = record('x', 1, { direction: 'inbound', remoteIdentity: 'anonymous@anonymous.invalid' });
    expect(planRedial(anonymous, registered, [])).toEqual({ ok: false, errorKey: 'history.noRedial' });
    expect(planRedial(record('y', 1, { remoteIdentity: 'Alice Smith' }), registered, [])).toMatchObject({ ok: false });
  });

  it('says why when that account is still setting up a call', () => {
    const setup = { call: { accountId: 'a1', direction: 'outbound', state: 'connecting' } } as unknown as CallView;
    expect(planRedial(record('x', 1), registered, [setup])).toEqual({ ok: false, errorKey: 'calls.error.setupInProgress' });
  });
});
