import { MAX_HISTORY_ENTRIES } from './types';
import type { CallRecord } from './types';

/** Newest first. A record with an id already listed replaces it; the oldest fall off at the cap. */
export function appendRecord(history: readonly CallRecord[], record: CallRecord): readonly CallRecord[] {
  const others = history.filter((existing) => existing.id !== record.id);
  return [record, ...others].slice(0, MAX_HISTORY_ENTRIES);
}

export function removeRecord(history: readonly CallRecord[], id: string): readonly CallRecord[] {
  return history.filter((record) => record.id !== id);
}

export function clearHistory(): readonly CallRecord[] {
  return [];
}

/** Talk time in ms, derived from the timestamps; absent when the call never connected. */
export function callDuration(record: CallRecord): number | undefined {
  if (record.connectedAt === undefined) return undefined;
  return Math.max(0, record.endedAt - record.connectedAt);
}

export type HistoryFilter = 'all' | 'missed';

const isMissed = (record: CallRecord): boolean => record.outcome === 'missed';

export function countMissed(history: readonly CallRecord[]): number {
  return history.filter(isMissed).length;
}

export function filterHistory(history: readonly CallRecord[], filter: HistoryFilter): readonly CallRecord[] {
  return filter === 'missed' ? history.filter(isMissed) : history;
}
