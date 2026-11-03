import { describe, expect, it } from 'vitest';
import {
  InvalidRegistrationTransitionError,
  canRetry,
  initialRegistration,
  reduceRegistration,
  registrationStateKey
} from '../../src/core/sip/registration';
import type { RegistrationEvent, RegistrationSnapshot } from '../../src/core/sip/registration';
import type { RegistrationState } from '../../src/core/sip/types';

const ev = (type: RegistrationEvent['type']): RegistrationEvent =>
  type === 'failed' ? { type, reason: '503' } : ({ type } as RegistrationEvent);
const snap = (state: RegistrationState, attempts = 0, failureReason?: string): RegistrationSnapshot =>
  failureReason === undefined ? { state, attempts } : { state, attempts, failureReason };

describe('reduceRegistration allowed transitions', () => {
  it('starts offline with zero attempts', () => {
    expect(initialRegistration).toEqual({ state: 'offline', attempts: 0 });
  });

  it('offline --register--> registering and counts an attempt', () => {
    expect(reduceRegistration(initialRegistration, ev('register'))).toEqual(snap('registering', 1));
  });

  it('registering --registered--> registered, resets attempts and clears the reason', () => {
    expect(reduceRegistration(snap('registering', 3, 'old'), ev('registered'))).toEqual(
      snap('registered', 0)
    );
  });

  it('registering --failed--> failed storing the reason', () => {
    expect(
      reduceRegistration(snap('registering', 2), { type: 'failed', reason: '403 Forbidden' })
    ).toEqual(snap('failed', 2, '403 Forbidden'));
  });

  it('failed --retry--> registering with attempts+1 and cleared reason', () => {
    expect(reduceRegistration(snap('failed', 2, 'x'), ev('retry'))).toEqual(snap('registering', 3));
  });

  it('registered --unregister--> offline', () => {
    expect(reduceRegistration(snap('registered'), ev('unregister'))).toEqual(snap('offline', 0));
  });

  it('failed --unregister--> offline, clearing reason and attempts', () => {
    expect(reduceRegistration(snap('failed', 2, 'x'), ev('unregister'))).toEqual(snap('offline', 0));
  });

  it('registered --failed--> failed', () => {
    expect(reduceRegistration(snap('registered'), { type: 'failed', reason: 'lost' })).toEqual(
      snap('failed', 0, 'lost')
    );
  });

  it('does not mutate its input', () => {
    const before = snap('failed', 1, 'r');
    reduceRegistration(before, ev('retry'));
    expect(before).toEqual(snap('failed', 1, 'r'));
  });
});

const allowed: Record<RegistrationState, RegistrationEvent['type'][]> = {
  offline: ['register'],
  registering: ['registered', 'failed'],
  registered: ['unregister', 'failed'],
  failed: ['retry', 'unregister']
};
const everyEvent: RegistrationEvent['type'][] = [
  'register',
  'registered',
  'failed',
  'unregister',
  'retry'
];
const rejected = (Object.keys(allowed) as RegistrationState[]).flatMap((state) =>
  everyEvent.filter((e) => !allowed[state].includes(e)).map((e) => [state, e] as const)
);

describe('reduceRegistration rejected transitions', () => {
  it.each(rejected)('%s + %s throws', (state, type) => {
    expect(() => reduceRegistration(snap(state), ev(type))).toThrow(
      InvalidRegistrationTransitionError
    );
    try {
      reduceRegistration(snap(state), ev(type));
    } catch (error) {
      expect(error).toMatchObject({ from: state, event: type, name: 'InvalidRegistrationTransitionError' });
    }
  });

  it('covers 20 - 7 = 13 invalid pairs', () => {
    expect(rejected).toHaveLength(13);
  });
});

describe('canRetry', () => {
  it('is true only below the max while failed', () => {
    expect(canRetry(snap('failed', 2), 3)).toBe(true);
    expect(canRetry(snap('failed', 3), 3)).toBe(false);
    expect(canRetry(snap('failed', 4), 3)).toBe(false);
  });

  it.each(['offline', 'registering', 'registered'] as const)('is false while %s', (state) => {
    expect(canRetry(snap(state, 0), 3)).toBe(false);
  });
});

describe('registrationStateKey', () => {
  it('maps to an i18n key', () => {
    expect(registrationStateKey('registered')).toBe('registration.state.registered');
    expect(registrationStateKey('offline')).toBe('registration.state.offline');
  });
});
