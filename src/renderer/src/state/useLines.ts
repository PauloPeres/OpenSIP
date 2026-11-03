import { useRef, useState } from 'react';
import type { CallView } from '../../../shared/api';

export interface Line {
  readonly view: CallView;
  /** Stable 1-based line number, kept for the whole life of the call. */
  readonly slot: number;
}

export interface LinesModel {
  readonly lines: readonly Line[];
  readonly focused: Line | null;
  readonly focus: (callId: string) => void;
}

function freeSlot(slots: ReadonlyMap<string, number>): number {
  const used = new Set(slots.values());
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function assignSlots(slots: Map<string, number>, calls: readonly CallView[]): void {
  const live = new Set(calls.map((c) => c.call.id));
  for (const id of [...slots.keys()]) if (!live.has(id)) slots.delete(id);
  for (const c of calls) if (!slots.has(c.call.id)) slots.set(c.call.id, freeSlot(slots));
}

/** Ringing calls first, then by line number. */
function ordered(slots: ReadonlyMap<string, number>, calls: readonly CallView[]): readonly Line[] {
  const lines = calls.map((view) => ({ view, slot: slots.get(view.call.id) ?? 0 }));
  const rank = (l: Line): number => (l.view.call.state === 'ringing' ? 0 : 1);
  return [...lines].sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
}

function pickFocus(lines: readonly Line[], wanted: string | null): Line | null {
  const quiet = lines.filter((l) => l.view.call.state !== 'ringing');
  return quiet.find((l) => l.view.call.id === wanted) ?? quiet[0] ?? null;
}

export function useLines(calls: readonly CallView[]): LinesModel {
  const slots = useRef(new Map<string, number>());
  const [wanted, setWanted] = useState<string | null>(null);
  assignSlots(slots.current, calls);
  const lines = ordered(slots.current, calls);
  return { lines, focused: pickFocus(lines, wanted), focus: setWanted };
}
