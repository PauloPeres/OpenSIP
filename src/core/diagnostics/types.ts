export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic, starts at 1, never reused. */
  readonly id: number;
  /** Epoch milliseconds from the injected clock. */
  readonly at: number;
  readonly level: LogLevel;
  /** Absent for app-wide entries. */
  readonly accountId?: string;
  /** i18n key, e.g. 'logs.event.registered' - never prose. */
  readonly messageKey: string;
  /** Interpolation params for that key; already redacted. */
  readonly params?: Readonly<Record<string, string>>;
  /** Raw SIP message, present only when debug was on; already redacted. */
  readonly raw?: string;
}

export interface LogOptions {
  readonly capacity: number;
  readonly debug: boolean;
}

export interface LogFilter {
  readonly accountId?: string;
  readonly minLevel?: LogLevel;
}

export type NewLogEntry = Omit<LogEntry, 'id' | 'at'>;

export interface DiagnosticsLog {
  /** Returns undefined when the entry was filtered out. */
  append(entry: NewLogEntry): LogEntry | undefined;
  entries(filter?: LogFilter): readonly LogEntry[];
  clear(): void;
  setDebug(enabled: boolean): void;
  readonly debug: boolean;
  readonly size: number;
}
