import { CALL_OUTCOMES, MAX_HISTORY_ENTRIES } from './types';
import type { CallOutcome, CallRecord } from './types';

type Raw = Readonly<Record<string, unknown>>;

const isRaw = (value: unknown): value is Raw => value instanceof Object;
const isText = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is number => Number.isFinite(value);
const isOutcome = (value: unknown): value is CallOutcome => CALL_OUTCOMES.includes(value as CallOutcome);
const isDirection = (value: unknown): value is CallRecord['direction'] => value === 'inbound' || value === 'outbound';

type Check = (value: unknown) => boolean;

const REQUIRED: Readonly<Record<string, Check>> = {
  id: (value) => isText(value) && value !== '',
  accountId: isText,
  direction: isDirection,
  remoteIdentity: isText,
  startedAt: isTime,
  endedAt: isTime,
  outcome: isOutcome
};

const OPTIONAL: Readonly<Record<string, Check>> = { connectedAt: isTime, endReasonKey: isText };

const fieldsOk = (raw: Raw, checks: Readonly<Record<string, Check>>, optional: boolean): boolean =>
  Object.entries(checks).every(([key, check]) => (optional && raw[key] === undefined) || check(raw[key]));

/** The record as it is meant to be, with unknown fields left behind; undefined for anything else. */
function toRecord(raw: unknown): CallRecord | undefined {
  if (!isRaw(raw) || !fieldsOk(raw, REQUIRED, false) || !fieldsOk(raw, OPTIONAL, true)) return undefined;
  const known = [...Object.keys(REQUIRED), ...Object.keys(OPTIONAL)].filter((key) => raw[key] !== undefined);
  return Object.fromEntries(known.map((key) => [key, raw[key]])) as unknown as CallRecord;
}

/** Reads history from untrusted storage: a missing or damaged file is an empty history, a damaged entry is skipped. */
export function parseHistory(value: unknown): readonly CallRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: CallRecord[] = [];
  for (const raw of value) {
    const record = toRecord(raw);
    if (record === undefined || seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return records.slice(0, MAX_HISTORY_ENTRIES);
}
