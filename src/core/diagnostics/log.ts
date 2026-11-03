import { redactDetails, redactSipMessage } from './redact';
import type {
  DiagnosticsLog,
  LogEntry,
  LogFilter,
  LogLevel,
  LogOptions,
  NewLogEntry
} from './types';

export const DEFAULT_LOG_CAPACITY = 500;

export const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export function meetsLevel(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function buildEntry(entry: NewLogEntry, id: number, at: number, debug: boolean): LogEntry {
  const { accountId, params, raw } = entry;
  return {
    id,
    at,
    level: entry.level,
    ...(accountId === undefined ? {} : { accountId }),
    messageKey: entry.messageKey,
    ...(params === undefined ? {} : { params: redactDetails(params) }),
    ...(debug && raw !== undefined ? { raw: redactSipMessage(raw) } : {})
  };
}

function matches(entry: LogEntry, filter: LogFilter): boolean {
  const accountOk = filter.accountId === undefined || entry.accountId === filter.accountId;
  const levelOk = filter.minLevel === undefined || meetsLevel(entry.level, filter.minLevel);
  return accountOk && levelOk;
}

class RingDiagnosticsLog implements DiagnosticsLog {
  private buffer: LogEntry[] = [];
  private nextId = 1;
  private enabled: boolean;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: Partial<LogOptions>, now: () => number) {
    this.enabled = options.debug ?? false;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_LOG_CAPACITY);
    this.now = now;
  }

  get debug(): boolean {
    return this.enabled;
  }

  get size(): number {
    return this.buffer.length;
  }

  setDebug(enabled: boolean): void {
    this.enabled = enabled;
  }

  append(entry: NewLogEntry): LogEntry | undefined {
    if (entry.level === 'debug' && !this.enabled) return undefined;
    const stored = buildEntry(entry, this.nextId, this.now(), this.enabled);
    this.nextId += 1;
    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    return stored;
  }

  entries(filter: LogFilter = {}): readonly LogEntry[] {
    return this.buffer.filter((entry) => matches(entry, filter));
  }

  clear(): void {
    this.buffer = [];
  }
}

export function createDiagnosticsLog(
  options: Partial<LogOptions> = {},
  now: () => number = () => Date.now()
): DiagnosticsLog {
  return new RingDiagnosticsLog(options, now);
}

type Translate = (key: string, params?: Readonly<Record<string, string>>) => string;

function safeTranslate(translate: Translate, entry: LogEntry): string {
  try {
    const text = translate(entry.messageKey, entry.params);
    return text === '' ? entry.messageKey : text;
  } catch {
    return entry.messageKey;
  }
}

/** Renders entries as plain text for the "copy all" button. */
export function formatEntries(entries: readonly LogEntry[], translate: Translate): string {
  return entries
    .map(
      (entry) =>
        `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${safeTranslate(translate, entry)}`
    )
    .join('\n');
}
