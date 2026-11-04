import { useEffect } from 'react';
import type { Line } from './useLines';
import { startTone, stopTone, unlockAudio } from '../ring/ringer';
import { chooseTone } from '../ring/tones';
import type { TonePrefs } from '../ring/tones';

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

/**
 * The one tone the phone makes: the incoming ring, or ringback for an outbound call nobody has answered.
 * It ends with the call that asked for it, and on unmount.
 */
export function useRingtone(lines: readonly Line[], prefs: TonePrefs, locale: string): void {
  useAudioUnlock();
  const tone = chooseTone(lines, prefs, locale);
  useEffect(() => {
    if (tone !== null) startTone(tone);
    return stopTone;
  }, [tone]);
}
