import { describe, expect, it } from 'vitest';
import {
  MAX_EXPIRES_RAISES,
  MAX_RETRY_AFTER_MS,
  MIN_RETRY_AFTER_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_JITTER,
  backoffDelayMs,
  decideRetry,
  retryAfterDelayMs
} from '../../src/core/sip/retry';
import type { RegistrationFailure } from '../../src/core/sip/retry';

const response = (status: number, extra: object = {}): RegistrationFailure => ({ kind: 'response', status, ...extra });
const MIDDLE = 0.5;

describe('constants', () => {
  it('are the documented ones', () => {
    expect([RETRY_BASE_MS, RETRY_CAP_MS, RETRY_JITTER]).toEqual([5_000, 300_000, 0.25]);
    expect([MIN_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS]).toEqual([1_000, 3_600_000]);
  });
});

describe('backoffDelayMs', () => {
  it.each([
    [1, 5_000],
    [2, 10_000],
    [3, 20_000],
    [4, 40_000],
    [5, 80_000],
    [6, 160_000],
    [7, 300_000],
    [8, 300_000],
    [5_000, 300_000]
  ])('failure %i has nominal %i ms at the middle of the jitter range', (failures, nominal) => {
    expect(backoffDelayMs(failures, MIDDLE)).toBe(nominal);
  });

  it('treats zero or negative failures as the first', () => {
    expect(backoffDelayMs(0, MIDDLE)).toBe(5_000);
    expect(backoffDelayMs(-4, MIDDLE)).toBe(5_000);
  });

  it('spreads each step over 75% to 125% of nominal', () => {
    expect(backoffDelayMs(1, 0)).toBe(3_750);
    expect(backoffDelayMs(1, 1)).toBe(6_250);
    expect(backoffDelayMs(7, 0)).toBe(225_000);
    expect(backoffDelayMs(7, 1)).toBe(375_000);
    expect(backoffDelayMs(2, 0.25)).toBe(8_750);
  });

  it('rounds to whole milliseconds', () => {
    expect(backoffDelayMs(1, 0.123)).toBe(Math.round(5_000 * (0.75 + 0.5 * 0.123)));
    expect(Number.isInteger(backoffDelayMs(1, 0.123))).toBe(true);
  });
});

describe('retryAfterDelayMs', () => {
  it.each([
    [0, 1_000],
    [1, 1_000],
    [2, 2_000],
    [120, 120_000],
    [3_600, 3_600_000],
    [3_601, 3_600_000],
    [31_536_000, 3_600_000]
  ])('Retry-After %i s waits %i ms', (seconds, expected) => {
    expect(retryAfterDelayMs(seconds)).toBe(expected);
  });
});

describe('decideRetry: retry table', () => {
  it.each([408, 480, 500, 502, 503, 504, 600, 603, 604, 606, 650, 699])('retries %i with backoff', (status) => {
    expect(decideRetry(response(status), 3, MIDDLE)).toEqual({ action: 'retry', delayMs: 20_000 });
  });

  it.each([
    400, 401, 402, 403, 404, 405, 406, 407, 410, 413, 415, 420, 421, 422, 424, 481, 486, 487, 488, 491, 493, 501, 505, 513,
    599, 700, 100, 200
  ])('does not retry %i', (status) => {
    expect(decideRetry(response(status), 1, MIDDLE)).toEqual({ action: 'stop' });
  });

  it('retries a transport failure with backoff', () => {
    expect(decideRetry({ kind: 'transport' }, 1, MIDDLE)).toEqual({ action: 'retry', delayMs: 5_000 });
    expect(decideRetry({ kind: 'transport' }, 2, 0)).toEqual({ action: 'retry', delayMs: 7_500 });
  });

  it('keeps retrying however many failures there have been', () => {
    expect(decideRetry(response(503), 1_000, MIDDLE)).toEqual({ action: 'retry', delayMs: 300_000 });
    expect(decideRetry({ kind: 'transport' }, 1_000, MIDDLE)).toEqual({ action: 'retry', delayMs: 300_000 });
  });
});

describe('decideRetry: Retry-After', () => {
  it('uses it instead of the backoff', () => {
    expect(decideRetry(response(503, { retryAfter: 120 }), 1, MIDDLE)).toEqual({ action: 'retry', delayMs: 120_000 });
    expect(decideRetry(response(500, { retryAfter: 2 }), 6, MIDDLE)).toEqual({ action: 'retry', delayMs: 2_000 });
  });

  it('clamps it', () => {
    expect(decideRetry(response(503, { retryAfter: 0 }), 1, MIDDLE)).toEqual({ action: 'retry', delayMs: 1_000 });
    expect(decideRetry(response(503, { retryAfter: 999_999 }), 1, MIDDLE)).toEqual({ action: 'retry', delayMs: 3_600_000 });
  });

  it('never makes a terminal status retryable', () => {
    expect(decideRetry(response(403, { retryAfter: 5 }), 1, MIDDLE)).toEqual({ action: 'stop' });
  });
});

describe('decideRetry: 423 Interval Too Brief', () => {
  it('re-registers with the Min-Expires when it is above what we asked for', () => {
    expect(decideRetry(response(423, { minExpires: 3600, requested: 600 }), 1, MIDDLE)).toEqual({
      action: 'reregister',
      expires: 3600
    });
    expect(decideRetry(response(423, { minExpires: 601, requested: 600 }), 1, MIDDLE)).toEqual({
      action: 'reregister',
      expires: 601
    });
  });

  it('obeys a climbing Min-Expires twice and then gives up', () => {
    expect(MAX_EXPIRES_RAISES).toBe(2);
    const at = (raises: number) => decideRetry(response(423, { minExpires: 900, requested: 600, raises }), 1, MIDDLE);
    expect(at(0)).toEqual({ action: 'reregister', expires: 900 });
    expect(at(1)).toEqual({ action: 'reregister', expires: 900 });
    expect(at(2)).toEqual({ action: 'stop' });
    expect(at(3)).toEqual({ action: 'stop' });
  });

  it.each([
    ['equal to what we asked for', { minExpires: 600, requested: 600 }],
    ['below what we asked for', { minExpires: 100, requested: 600 }],
    ['absent', { requested: 600 }],
    ['without a request to compare with', { minExpires: 3600 }],
    ['entirely absent', {}]
  ])('stops when Min-Expires is %s, so a confused server cannot loop us', (_name, extra) => {
    expect(decideRetry(response(423, extra), 1, MIDDLE)).toEqual({ action: 'stop' });
  });
});
