import { useState } from 'react';
import { readStored, writeStored } from './storage';

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

const KEY = 'opensip.theme';

export function isTheme(value: string | null): value is ThemeChoice {
  return THEMES.some((choice) => choice === value);
}

export function readTheme(): ThemeChoice {
  const stored = readStored(KEY);
  return isTheme(stored) ? stored : 'system';
}

/** An explicit choice sets `data-theme` on the root; System removes it so the OS decides. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function useTheme(): readonly [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const update = (next: ThemeChoice): void => {
    setChoice(next);
    writeStored(KEY, next);
    applyTheme(next);
  };
  return [choice, update];
}
