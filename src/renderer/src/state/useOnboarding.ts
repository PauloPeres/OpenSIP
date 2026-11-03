import { useStoredFlag } from './storage';

const DONE_KEY = 'opensip.onboarded';

export interface OnboardingModel {
  readonly done: boolean;
  readonly finish: () => void;
}

/** First-run state. When storage is unavailable the flow shows once per launch instead of trapping anyone. */
export function useOnboarding(): OnboardingModel {
  const [done, setDone] = useStoredFlag(DONE_KEY, false);
  return { done, finish: () => setDone(true) };
}
