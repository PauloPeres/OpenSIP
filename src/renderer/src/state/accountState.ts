import type { AccountView } from '../../../shared/api';

/** What to show for the account: a deliberately turned-off account is calm, never a failure. */
export function displayState(view: AccountView): string {
  return view.account.enabled ? view.registration.state : 'disabled'; // i18n-exempt: state name
}

export function stateKey(view: AccountView): string {
  return `registration.state.${displayState(view)}`;
}
