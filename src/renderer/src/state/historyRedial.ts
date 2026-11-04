import { pickRedialAccount, redialTarget } from '@core/history';
import type { CallRecord } from '@core/history';
import type { AccountId } from '@core/sip';
import { SETUP_IN_PROGRESS_KEY, isOutboundInSetup } from '../../../shared/api';
import type { AccountView, CallView } from '../../../shared/api';

export type RedialPlan =
  | { readonly ok: true; readonly accountId: AccountId; readonly target: string }
  | { readonly ok: false; readonly errorKey: string };

const refuse = (errorKey: string): RedialPlan => ({ ok: false, errorKey });

function registeredIds(accounts: readonly AccountView[]): readonly AccountId[] {
  return accounts.filter((a) => a.account.enabled && a.registration.state === 'registered').map((a) => a.account.id);
}

/**
 * Redial goes through the ordinary dial path. Every refusal names its reason,
 * so a click never ends in silence.
 */
export function planRedial(record: CallRecord, accounts: readonly AccountView[], calls: readonly CallView[]): RedialPlan {
  const target = redialTarget(record.remoteIdentity);
  if (target === undefined) return refuse('history.noRedial'); // i18n-exempt: translation key
  const accountId = pickRedialAccount(record.accountId, registeredIds(accounts));
  if (accountId === undefined) return refuse('calls.error.noAccount'); // i18n-exempt: translation key
  if (calls.some((view) => isOutboundInSetup(view.call, accountId))) return refuse(SETUP_IN_PROGRESS_KEY);
  return { ok: true, accountId, target };
}
