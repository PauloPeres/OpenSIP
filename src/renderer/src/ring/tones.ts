import type { TonePattern } from './ringer';
import { isIncomingRing } from '../state/useLines';
import type { Line } from '../state/useLines';
import { progressKey } from '../state/callProgress';

/** North American ring: 440 + 480 Hz, two seconds on, four off. Also the incoming ringtone everywhere. */
export const NORTH_AMERICA_TONE: TonePattern = { frequencies: [440, 480], onSeconds: 2, cycleMs: 6000 };
/** Brazilian ringback (ABNT NBR 13300 cadence): 425 Hz, one second on, four off. */
export const BRAZIL_RINGBACK: TonePattern = { frequencies: [425], onSeconds: 1, cycleMs: 5000 };

const BRAZIL_LOCALE = 'pt-BR'; // i18n-exempt: locale code
const RINGING = 'calls.progress.ringing'; // i18n-exempt: translation key

export interface TonePrefs {
  readonly ringtone: boolean;
  readonly ringback: boolean;
}

/**
 * Our own ringback is only for an outbound call the far end reports as ringing with no audio of its own.
 * Once a media stream exists (early media from a 183) the network is the one making the sound.
 */
export function needsLocalRingback(line: Line): boolean {
  const { view } = line;
  return view.call.direction === 'outbound' && view.media === undefined && progressKey(view) === RINGING;
}

/** The ringback cadence follows the interface language, which is the best locale signal the app has. */
export function ringbackFor(locale: string): TonePattern {
  return locale === BRAZIL_LOCALE ? BRAZIL_RINGBACK : NORTH_AMERICA_TONE;
}

/**
 * One tone at most. An incoming ring outranks ringback because it is the one asking for an action; its
 * own switch decides whether it sounds, and when it is off the ringback is still allowed.
 */
export function chooseTone(lines: readonly Line[], prefs: TonePrefs, locale: string): TonePattern | null {
  if (prefs.ringtone && lines.some(isIncomingRing)) return NORTH_AMERICA_TONE;
  if (prefs.ringback && lines.some(needsLocalRingback)) return ringbackFor(locale);
  return null;
}
