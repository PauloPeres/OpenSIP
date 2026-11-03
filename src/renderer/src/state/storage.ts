import { useCallback, useState } from 'react';

/** localStorage can throw (blocked storage, private contexts), so every access is guarded. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience; the app keeps working for this session.
  }
}

const ON = '1';
const OFF = '0';

export function useStoredFlag(key: string, fallback: boolean): readonly [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    const stored = readStored(key);
    return stored === null ? fallback : stored === ON;
  });
  const update = useCallback(
    (next: boolean): void => {
      setValue(next);
      writeStored(key, next ? ON : OFF);
    },
    [key]
  );
  return [value, update];
}
