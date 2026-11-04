/*
 * When a failed registration is worth trying again, and how long to wait.
 *
 * Pure and table-driven: the caller supplies the failure, how many failures in
 * a row there have been, and a random number in [0, 1). The timers stay in
 * src/main.
 */

/** What went wrong with a REGISTER, as far as the retry decision is concerned. */
export type RegistrationFailure =
  | { readonly kind: 'transport' }
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Seconds from a Retry-After header. */
      readonly retryAfter?: number;
      /** Seconds from a Min-Expires header (423). */
      readonly minExpires?: number;
      /** The Expires we asked for, so a 423 that asks for no more than that is not obeyed. */
      readonly requested?: number;
      /** How many times in a row we have already raised Expires for a 423 without succeeding. */
      readonly raises?: number;
    };

export type RetryDecision =
  | { readonly action: 'stop' }
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'reregister'; readonly expires: number };

/** First wait: long enough not to hammer a server that is restarting, short enough that a blip is invisible. */
export const RETRY_BASE_MS = 5_000;
/**
 * Longest nominal wait. Five minutes is PJSIP's own default registration retry interval: an account that
 * can come back does so within minutes, while a server that is down for hours sees one request per
 * client per five minutes instead of a flood.
 */
export const RETRY_CAP_MS = 300_000;
/**
 * Each wait is scaled by a random factor in [1 - J, 1 + J]. After a server restart every client fails at
 * the same instant, so without jitter they would all return together on the same schedule. 25% spreads a
 * 5 s step over 3.75 to 6.25 s and a capped step over 225 to 375 s, while still keeping the exponential
 * growth between steps (the ranges of consecutive steps overlap only slightly).
 */
export const RETRY_JITTER = 0.25;
/** A Retry-After of 0, or a hostile one of a year, is clamped to this range. */
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 3_600_000;
/** A server whose Min-Expires keeps climbing must not keep us in a loop: obey it twice, then treat the 423 as terminal. */
export const MAX_EXPIRES_RAISES = 2;

/** Responses that mean "the server or the route is unwell, try again": 408 480 500 502 503 504, and every 6xx. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 480, 500, 502, 503, 504]);
const FIRST_GLOBAL_FAILURE = 600;
const LAST_GLOBAL_FAILURE = 699;
const INTERVAL_TOO_BRIEF = 423;

const STOP: RetryDecision = { action: 'stop' };

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUSES.has(status) || (status >= FIRST_GLOBAL_FAILURE && status <= LAST_GLOBAL_FAILURE);

/** `failures` is the number of consecutive failures including this one; the first waits the base delay. */
export function backoffDelayMs(failures: number, random: number): number {
  const step = Math.max(1, failures) - 1;
  const nominal = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** step);
  return Math.round(nominal * (1 - RETRY_JITTER + 2 * RETRY_JITTER * random));
}

/** The server's Retry-After, kept inside sane bounds, in milliseconds. */
export function retryAfterDelayMs(seconds: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, seconds * 1000));
}

function delayFor(retryAfter: number | undefined, failures: number, random: number): number {
  return retryAfter === undefined ? backoffDelayMs(failures, random) : retryAfterDelayMs(retryAfter);
}

function onIntervalTooBrief(failure: Extract<RegistrationFailure, { kind: 'response' }>): RetryDecision {
  const { minExpires, requested, raises = 0 } = failure;
  if (minExpires === undefined || requested === undefined || minExpires <= requested) return STOP;
  return raises >= MAX_EXPIRES_RAISES ? STOP : { action: 'reregister', expires: minExpires };
}

function onResponse(failure: Extract<RegistrationFailure, { kind: 'response' }>, failures: number, random: number): RetryDecision {
  if (failure.status === INTERVAL_TOO_BRIEF) return onIntervalTooBrief(failure);
  if (!isRetryableStatus(failure.status)) return STOP;
  return { action: 'retry', delayMs: delayFor(failure.retryAfter, failures, random) };
}

/**
 * Terminal (the user must act): 401/407 reaching here means the digest path already failed, 403, 404 and
 * every other status not listed as retryable. 423 is answered by registering again with the Min-Expires.
 */
export function decideRetry(failure: RegistrationFailure, failures: number, random: number): RetryDecision {
  if (failure.kind === 'transport') return { action: 'retry', delayMs: backoffDelayMs(failures, random) };
  return onResponse(failure, failures, random);
}
