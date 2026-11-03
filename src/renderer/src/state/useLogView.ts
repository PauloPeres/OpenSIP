import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject, UIEvent } from 'react';
import type { AppSnapshot } from '../../../shared/api';

export type LogEntry = AppSnapshot['logs'][number];
export type LogLevel = LogEntry['level'];

export const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogFilter {
  readonly accountId: string;
  readonly minLevel: LogLevel;
}

export function filterLogs(logs: readonly LogEntry[], filter: LogFilter, clearedBefore: number): readonly LogEntry[] {
  const floor = LEVELS.indexOf(filter.minLevel);
  return logs.filter(
    (entry) =>
      entry.id > clearedBefore &&
      LEVELS.indexOf(entry.level) >= floor &&
      (filter.accountId === '' || entry.accountId === filter.accountId)
  );
}

export interface StickyScroll {
  readonly ref: RefObject<HTMLDivElement>;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

const NEAR_BOTTOM_PX = 32;

/** Keeps the list pinned to the newest entry unless the user has scrolled up to read. */
export function useStickyScroll(latestId: number | undefined): StickyScroll {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight;
  }, [latestId]);
  return { ref, onScroll };
}

/** Flashes `true` for a moment after `trigger()` has been called. */
export function useFlash(ms: number): readonly [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return undefined;
    const id = window.setTimeout(() => setOn(false), ms);
    return (): void => window.clearTimeout(id);
  }, [on, ms]);
  return [on, (): void => setOn(true)];
}
