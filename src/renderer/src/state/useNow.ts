import { useEffect, useState } from 'react';

/** Wall clock that ticks every second while `active`; idle otherwise so nothing re-renders. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return (): void => window.clearInterval(id);
  }, [active]);
  return now;
}
