import { useRef } from 'react';
import { isPending } from './callProgress';
import type { Line } from './useLines';

/**
 * When each call was first seen being set up. The engine sends no start time, so the clock
 * starts when the renderer first sees the call pending; that is within a moment of the dial.
 */
export function useSetupClock(lines: readonly Line[]): ReadonlyMap<string, number> {
  const starts = useRef(new Map<string, number>());
  const live = new Set(lines.map((l) => l.view.call.id));
  for (const id of [...starts.current.keys()]) if (!live.has(id)) starts.current.delete(id);
  for (const l of lines) {
    if (isPending(l.view) && !starts.current.has(l.view.call.id)) starts.current.set(l.view.call.id, Date.now());
  }
  return starts.current;
}
