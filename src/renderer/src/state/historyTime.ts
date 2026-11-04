import type { CallRecord } from '@core/history';

const DAY_MS = 86_400_000;

/** Midnight, local time, of the day `at` falls on. */
export function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface DayGroup {
  readonly day: number;
  readonly records: readonly CallRecord[];
}

/** Consecutive records of one local day, in the order given (history is newest first). */
export function groupByDay(records: readonly CallRecord[]): readonly DayGroup[] {
  const groups: { day: number; records: CallRecord[] }[] = [];
  for (const record of records) {
    const day = dayStart(record.endedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.records.push(record);
    else groups.push({ day, records: [record] });
  }
  return groups;
}

/** Today and yesterday come from Intl in the active language; older days are a plain date. */
export function dayLabel(locale: string, day: number, now: number): string {
  const diff = Math.round((day - dayStart(now)) / DAY_MS);
  if (diff === 0 || diff === -1) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day');
  const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();
  const year = sameYear ? {} : { year: 'numeric' as const };
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', ...year }).format(day);
}

export function timeLabel(locale: string, at: number): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);
}

/** The exact moment, for a tooltip. */
export function fullLabel(locale: string, at: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' }).format(at);
}
