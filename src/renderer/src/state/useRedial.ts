import { useState } from 'react';
import type { CallRecord } from '@core/history';
import { planRedial } from './historyRedial';
import type { DialerArgs } from './useDialer';

/** Redial places a call exactly as the dialer does, so it takes what the dialer takes. */
export type RedialArgs = DialerArgs;

export interface Redial {
  readonly redial: (record: CallRecord) => void;
  readonly errorKey: string | null;
  readonly busy: boolean;
}

const FAILED_KEY = 'calls.error.failed'; // i18n-exempt: translation key

export function useRedial({ accounts, calls, dial, onDialed }: RedialArgs): Redial {
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redial = (record: CallRecord): void => {
    const plan = planRedial(record, accounts, calls);
    setErrorKey(plan.ok ? null : plan.errorKey);
    if (!plan.ok || busy) return;
    setBusy(true);
    dial(plan.accountId, plan.target)
      .then((result) => (result.ok ? onDialed(result.callId) : setErrorKey(result.errorKey)))
      .catch(() => setErrorKey(FAILED_KEY))
      .finally(() => setBusy(false));
  };
  return { redial, errorKey, busy };
}
