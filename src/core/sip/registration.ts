import type { RegistrationState } from './types';

export type RegistrationEvent =
  | { type: 'register' }
  | { type: 'registered' }
  | { type: 'failed'; reason: string }
  | { type: 'unregister' }
  | { type: 'retry' };

type EventType = RegistrationEvent['type'];
type FailedEvent = Extract<RegistrationEvent, { type: 'failed' }>;

export interface RegistrationSnapshot {
  readonly state: RegistrationState;
  readonly failureReason?: string;
  readonly attempts: number;
}

export class InvalidRegistrationTransitionError extends Error {
  readonly from: RegistrationState;
  readonly event: EventType;

  constructor(from: RegistrationState, event: EventType) {
    super('invalid-registration-transition');
    this.name = 'InvalidRegistrationTransitionError';
    this.from = from;
    this.event = event;
  }
}

export const initialRegistration: RegistrationSnapshot = { state: 'offline', attempts: 0 };

const ALLOWED: Readonly<Record<RegistrationState, readonly EventType[]>> = {
  offline: ['register'],
  registering: ['registered', 'failed'],
  registered: ['unregister', 'failed'],
  failed: ['retry', 'unregister']
};

type Apply = (current: RegistrationSnapshot, event: RegistrationEvent) => RegistrationSnapshot;

const attempting: Apply = (current) => ({ state: 'registering', attempts: current.attempts + 1 });

const APPLY: Readonly<Record<EventType, Apply>> = {
  register: attempting,
  retry: attempting,
  registered: () => ({ state: 'registered', attempts: 0 }),
  unregister: () => initialRegistration,
  failed: (current, event) => ({
    state: 'failed',
    attempts: current.attempts,
    failureReason: (event as FailedEvent).reason
  })
};

export function reduceRegistration(
  current: RegistrationSnapshot,
  event: RegistrationEvent
): RegistrationSnapshot {
  if (!ALLOWED[current.state].includes(event.type)) {
    throw new InvalidRegistrationTransitionError(current.state, event.type);
  }
  return APPLY[event.type](current, event);
}

export function canRetry(snapshot: RegistrationSnapshot, maxAttempts: number): boolean {
  return snapshot.state === 'failed' && snapshot.attempts < maxAttempts;
}

export function registrationStateKey(state: RegistrationState): string {
  return `registration.state.${state}`;
}
