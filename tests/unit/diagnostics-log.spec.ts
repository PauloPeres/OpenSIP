import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOG_CAPACITY,
  LEVEL_ORDER,
  createDiagnosticsLog,
  formatEntries,
  meetsLevel
} from '../../src/core/diagnostics/log';
import type { LogEntry, LogLevel } from '../../src/core/diagnostics/types';
import * as barrel from '../../src/core/diagnostics';

const HASH = '6629fae49393a05397450978507c4ef1';
const info = (extra: Partial<Omit<LogEntry, 'id' | 'at'>> = {}): Omit<LogEntry, 'id' | 'at'> => ({
  level: 'info',
  messageKey: 'logs.event.registered',
  ...extra
});

describe('constants and levels', () => {
  it('orders levels', () => {
    expect(LEVEL_ORDER).toEqual({ debug: 0, info: 1, warn: 2, error: 3 });
    expect(DEFAULT_LOG_CAPACITY).toBe(500);
  });

  it.each<[LogLevel, LogLevel, boolean]>([
    ['debug', 'debug', true],
    ['debug', 'info', false],
    ['info', 'info', true],
    ['info', 'debug', true],
    ['warn', 'info', true],
    ['warn', 'error', false],
    ['error', 'error', true]
  ])('meetsLevel(%s, %s) is %s', (level, min, expected) => {
    expect(meetsLevel(level, min)).toBe(expected);
  });

  it('re-exports the public surface from the barrel', () => {
    expect(barrel.createDiagnosticsLog).toBe(createDiagnosticsLog);
    expect(barrel.redactSipMessage).toBeTypeOf('function');
    expect(barrel.REDACTION).toBe('[redacted]');
  });
});

describe('defaults', () => {
  it('starts empty with debug off', () => {
    const log = createDiagnosticsLog();
    expect(log.size).toBe(0);
    expect(log.debug).toBe(false);
    expect(log.entries()).toEqual([]);
  });

  it('honours the debug option', () => {
    expect(createDiagnosticsLog({ debug: true }).debug).toBe(true);
  });

  it('uses the default capacity of 500', () => {
    const log = createDiagnosticsLog();
    for (let i = 0; i < 501; i += 1) log.append(info());
    expect(log.size).toBe(500);
  });
});

describe('ids and clock', () => {
  it('stamps monotonic ids from 1 and the injected clock', () => {
    let t = 1000;
    const log = createDiagnosticsLog({}, () => (t += 5));
    const a = log.append(info());
    const b = log.append(info());
    expect(a).toEqual({ id: 1, at: 1005, level: 'info', messageKey: 'logs.event.registered' });
    expect(b?.id).toBe(2);
    expect(b?.at).toBe(1010);
  });

  it('keeps accountId and params, and omits absent optional fields', () => {
    const log = createDiagnosticsLog();
    const e = log.append(info({ accountId: 'acc', params: { expires: '600' } }));
    expect(e).toEqual({
      id: 1,
      at: expect.any(Number),
      level: 'info',
      accountId: 'acc',
      messageKey: 'logs.event.registered',
      params: { expires: '600' }
    });
    const bare = log.append(info());
    expect(Object.keys(bare ?? {}).sort()).toEqual(['at', 'id', 'level', 'messageKey']);
  });
});

describe('debug switch', () => {
  it('drops debug entries while debug is off', () => {
    const log = createDiagnosticsLog();
    expect(log.append(info({ level: 'debug' }))).toBeUndefined();
    expect(log.size).toBe(0);
  });

  it('keeps debug entries while debug is on', () => {
    const log = createDiagnosticsLog({ debug: true });
    expect(log.append(info({ level: 'debug' }))?.level).toBe('debug');
    expect(log.size).toBe(1);
  });

  it.each<LogLevel>(['info', 'warn', 'error'])('always keeps %s entries', (level) => {
    const off = createDiagnosticsLog({ debug: false });
    const on = createDiagnosticsLog({ debug: true });
    expect(off.append(info({ level }))?.level).toBe(level);
    expect(on.append(info({ level }))?.level).toBe(level);
  });

  it('toggles at runtime in both directions', () => {
    const log = createDiagnosticsLog();
    const debugEntry = info({ level: 'debug' });
    expect(log.append(debugEntry)).toBeUndefined();
    log.setDebug(true);
    expect(log.debug).toBe(true);
    expect(log.append(debugEntry)?.id).toBe(1);
    log.setDebug(false);
    expect(log.debug).toBe(false);
    expect(log.append(debugEntry)).toBeUndefined();
    expect(log.size).toBe(1);
  });

  it('does not consume an id for a dropped entry', () => {
    const log = createDiagnosticsLog();
    log.append(info({ level: 'debug' }));
    expect(log.append(info())?.id).toBe(1);
  });

  it('keeps existing debug entries when debug is switched off', () => {
    const log = createDiagnosticsLog({ debug: true });
    log.append(info({ level: 'debug' }));
    log.setDebug(false);
    expect(log.size).toBe(1);
  });
});

describe('raw handling', () => {
  it('omits the raw property entirely when debug is off', () => {
    const log = createDiagnosticsLog();
    const e = log.append(info({ raw: 'REGISTER sip:x SIP/2.0' }));
    expect(e).toBeDefined();
    expect('raw' in (e ?? {})).toBe(false);
    expect('raw' in (log.entries()[0] ?? {})).toBe(false);
  });

  it('stores raw when debug is on', () => {
    const log = createDiagnosticsLog({ debug: true });
    const e = log.append(info({ raw: 'SIP/2.0 200 OK\r\nCSeq: 1 REGISTER' }));
    expect(e?.raw).toBe('SIP/2.0 200 OK\r\nCSeq: 1 REGISTER');
  });

  it('redacts raw on the way in', () => {
    const log = createDiagnosticsLog({ debug: true });
    log.append(
      info({ raw: `REGISTER sip:x SIP/2.0\r\nAuthorization: Digest username="1001", response="${HASH}"\r\n\r\n` })
    );
    const stored = log.entries()[0]?.raw;
    expect(stored).toBe(
      'REGISTER sip:x SIP/2.0\r\nAuthorization: Digest username="1001", response="[redacted]"\r\n\r\n'
    );
  });

  it('redacts params on the way in', () => {
    const log = createDiagnosticsLog();
    log.append(info({ params: { reason: 'password=hunter2', host: 'pbx' } }));
    expect(log.entries()[0]?.params).toEqual({ reason: 'password=[redacted]', host: 'pbx' });
  });

  it('does not keep a reference to the caller params', () => {
    const log = createDiagnosticsLog();
    const params = { a: 'b' };
    log.append(info({ params }));
    params.a = 'changed';
    expect(log.entries()[0]?.params).toEqual({ a: 'b' });
  });
});

describe('ring buffer', () => {
  const fill = (capacity: number, count: number): ReturnType<typeof createDiagnosticsLog> => {
    const log = createDiagnosticsLog({ capacity });
    for (let i = 0; i < count; i += 1) log.append(info({ params: { n: String(i + 1) } }));
    return log;
  };
  const ids = (log: ReturnType<typeof createDiagnosticsLog>): number[] => log.entries().map((e) => e.id);

  it('holds everything at capacity - 1', () => {
    const log = fill(3, 2);
    expect(log.size).toBe(2);
    expect(ids(log)).toEqual([1, 2]);
  });

  it('holds everything at capacity', () => {
    const log = fill(3, 3);
    expect(log.size).toBe(3);
    expect(ids(log)).toEqual([1, 2, 3]);
  });

  it('discards the oldest at capacity + 1 and does not reuse ids', () => {
    const log = fill(3, 4);
    expect(log.size).toBe(3);
    expect(ids(log)).toEqual([2, 3, 4]);
  });

  it('keeps discarding oldest first', () => {
    const log = fill(3, 10);
    expect(ids(log)).toEqual([8, 9, 10]);
    expect(log.entries().map((e) => e.params?.['n'])).toEqual(['8', '9', '10']);
  });

  it('never goes below a capacity of one', () => {
    const log = fill(0, 3);
    expect(ids(log)).toEqual([3]);
  });
});

describe('entries filters', () => {
  const build = (): ReturnType<typeof createDiagnosticsLog> => {
    const log = createDiagnosticsLog({ debug: true });
    log.append(info({ accountId: 'a', level: 'debug' }));
    log.append(info({ accountId: 'a', level: 'info' }));
    log.append(info({ accountId: 'b', level: 'warn' }));
    log.append(info({ level: 'error' }));
    log.append(info({ accountId: 'a', level: 'error' }));
    return log;
  };
  const ids = (es: readonly LogEntry[]): number[] => es.map((e) => e.id);

  it('returns oldest first with no filter', () => {
    expect(ids(build().entries())).toEqual([1, 2, 3, 4, 5]);
    expect(ids(build().entries({}))).toEqual([1, 2, 3, 4, 5]);
  });

  it('filters by account', () => {
    expect(ids(build().entries({ accountId: 'a' }))).toEqual([1, 2, 5]);
    expect(ids(build().entries({ accountId: 'zzz' }))).toEqual([]);
  });

  it('filters by minimum level', () => {
    expect(ids(build().entries({ minLevel: 'debug' }))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(build().entries({ minLevel: 'info' }))).toEqual([2, 3, 4, 5]);
    expect(ids(build().entries({ minLevel: 'warn' }))).toEqual([3, 4, 5]);
    expect(ids(build().entries({ minLevel: 'error' }))).toEqual([4, 5]);
  });

  it('composes filters with AND', () => {
    expect(ids(build().entries({ accountId: 'a', minLevel: 'info' }))).toEqual([2, 5]);
    expect(ids(build().entries({ accountId: 'b', minLevel: 'error' }))).toEqual([]);
  });

  it('returns a copy that does not alias the buffer', () => {
    const log = build();
    const snapshot = log.entries() as LogEntry[];
    snapshot.pop();
    expect(log.entries()).toHaveLength(5);
  });
});

describe('clear', () => {
  it('empties the buffer without resetting ids', () => {
    const log = createDiagnosticsLog();
    log.append(info());
    log.append(info());
    log.clear();
    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
    expect(log.append(info())?.id).toBe(3);
  });
});

describe('formatEntries', () => {
  const t = (key: string, params?: Readonly<Record<string, string>>): string =>
    key === 'logs.event.registered' ? `Registered, renews in ${params?.['expires'] ?? ''}s` : key;

  it('renders one line per entry with ISO time, upper-case level and translation', () => {
    const entries: LogEntry[] = [
      { id: 1, at: 0, level: 'info', messageKey: 'logs.event.registered', params: { expires: '600' } },
      { id: 2, at: 1700000000123, level: 'warn', messageKey: 'logs.event.unregistered' }
    ];
    expect(formatEntries(entries, t)).toBe(
      '1970-01-01T00:00:00.000Z INFO Registered, renews in 600s\n' +
        '2023-11-14T22:13:20.123Z WARN logs.event.unregistered'
    );
  });

  it('returns an empty string for no entries', () => {
    expect(formatEntries([], t)).toBe('');
  });

  it('falls back to the key when translate throws', () => {
    const boom = (): string => {
      throw new Error('missing');
    };
    const e: LogEntry = { id: 1, at: 0, level: 'error', messageKey: 'logs.nope' };
    expect(formatEntries([e], boom)).toBe('1970-01-01T00:00:00.000Z ERROR logs.nope');
  });

  it('falls back to the key when translate returns an empty string', () => {
    const e: LogEntry = { id: 1, at: 0, level: 'debug', messageKey: 'logs.nope' };
    expect(formatEntries([e], () => '')).toBe('1970-01-01T00:00:00.000Z DEBUG logs.nope');
  });
});
