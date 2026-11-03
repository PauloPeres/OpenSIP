import type { AccountView } from '../../../shared/api';

/**
 * Sharing is only meaningful while we are registered. When the server told us nothing the
 * field is absent and nothing is shown: no information is not the same as all clear.
 */
export function sharingOf(view: AccountView): NonNullable<AccountView['sharing']> | null {
  const live = view.account.enabled && view.registration.state === 'registered';
  return live && view.sharing !== undefined ? view.sharing : null;
}

/** True when another device took this account over, so calls no longer reach us. */
export function isDisplaced(view: AccountView): boolean {
  return sharingOf(view)?.displaced === true;
}

/**
 * What to show for the account: a deliberately turned-off account is calm, never a failure,
 * and a taken-over account is a problem even though our last REGISTER succeeded.
 */
export function displayState(view: AccountView): string {
  if (isDisplaced(view)) return 'displaced'; // i18n-exempt: state name
  return view.account.enabled ? view.registration.state : 'disabled'; // i18n-exempt: state name
}

export function stateKey(view: AccountView): string {
  return `registration.state.${displayState(view)}`;
}
