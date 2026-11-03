import { useEffect } from 'react';
import { isIncomingRing } from './useLines';
import type { Line } from './useLines';
import { startRing, stopRing, unlockAudio } from '../ring/ringer';

/** Resumes a suspended AudioContext on the first gesture, then stops listening. */
function useAudioUnlock(): void {
  useEffect(() => {
    const events = ['pointerdown', 'keydown'];
    const release = (): void => events.forEach((name) => window.removeEventListener(name, unlock));
    const unlock = (): void => {
      unlockAudio();
      release();
    };
    events.forEach((name) => window.addEventListener(name, unlock));
    return release;
  }, []);
}

/** One shared ring for however many calls are ringing; it ends with the last of them. */
export function useRingtone(lines: readonly Line[], enabled: boolean): void {
  useAudioUnlock();
  const ringing = lines.some(isIncomingRing);
  const shouldRing = enabled && ringing;
  useEffect(() => {
    if (shouldRing) startRing();
    else stopRing();
    return stopRing;
  }, [shouldRing]);
}
