import type { AccountId } from '../sip/types';

const URI = /^sips?:[^\s@<>]+(?:@[^\s@<>]+)?$/i;
const ADDRESS = /^([^\s@<>:]+)@([^\s@<>]+)$/;
const NUMBER = /^\+?[0-9*#][0-9*#\s().-]*$/;
const ANONYMOUS_CALLER = /^(?:sips?:)?anonymous@/i;
const INVALID_HOST = /@[^@]*\.invalid$/i;

const isAnonymous = (address: string): boolean => ANONYMOUS_CALLER.test(address) || INVALID_HOST.test(address);

/**
 * What to dial to call this identity back, or undefined when the identity says
 * nothing we could dial: a display name, an anonymous caller, an empty string.
 * Guessing "Alice Smith" into a SIP user would ring a stranger.
 */
export function redialTarget(remoteIdentity: string): string | undefined {
  const identity = remoteIdentity.trim();
  if (!URI.test(identity) && !ADDRESS.test(identity) && !NUMBER.test(identity)) return undefined;
  return isAnonymous(identity) ? undefined : identity;
}

/** The account a redial goes out from: the one the call used when it is still registered, else any registered one. */
export function pickRedialAccount(preferred: AccountId, registered: readonly AccountId[]): AccountId | undefined {
  return registered.includes(preferred) ? preferred : registered[0];
}
