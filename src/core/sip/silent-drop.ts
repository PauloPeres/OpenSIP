import type { CallSession } from './types';
import { DEFAULT_USER_AGENT, effectiveUserAgent } from './user-agent';

/** The i18n key of the suggestion shown beside a call that ended with the silent-filter signature. */
export const SILENT_FILTER_HINT_KEY = 'calls.endHint.silentFilter';

const TRYING = 100;

/** What is known when an outbound call's setup ended. */
export interface SetupEnd {
  readonly direction: CallSession['direction'];
  /** Every provisional status received for the INVITE, in order of arrival. */
  readonly provisionals: readonly number[];
  /** The final status, when the server ever sent one. */
  readonly finalStatus: number | undefined;
  /** True when our own setup guard ended the call, as opposed to the server, the user or the far end. */
  readonly timedOut: boolean;
}

/**
 * The signature of an INVITE dropped by a User-Agent filter, seen from the client: an outbound call that got
 * at least one 100 and nothing else at all (no 18x, no other provisional, no final response) until our own
 * guard gave up. A 180 or 183 means the far end was reached, so quiet after it is an ordinary timeout. No 100
 * at all is plain loss, not a server that accepted the request and then stopped. Inbound calls never qualify.
 */
export function isSilentAfterTrying(end: SetupEnd): boolean {
  const { provisionals } = end;
  const onlyTrying = provisionals.length > 0 && provisionals.every((status) => status === TRYING);
  return end.direction === 'outbound' && end.timedOut && end.finalStatus === undefined && onlyTrying;
}

/**
 * The suggestion for a call that ended that way, or undefined when there is none to make. A user who has
 * already moved the User-Agent off the default has acted on the same advice, so it is not repeated.
 */
export function silentFilterHintKey(end: SetupEnd, userAgentSetting: string): string | undefined {
  if (!isSilentAfterTrying(end)) return undefined;
  return effectiveUserAgent(userAgentSetting) === DEFAULT_USER_AGENT ? SILENT_FILTER_HINT_KEY : undefined;
}
