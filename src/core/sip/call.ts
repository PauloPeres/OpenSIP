import type { AccountId, CallSession, CallState } from './types';

export type CallEvent =
  | { type: 'answer' }
  | { type: 'reject' }
  | { type: 'connected' }
  | { type: 'hangup' }
  | { type: 'hold' }
  | { type: 'resume' }
  | { type: 'remoteHangup' };

type EventType = CallEvent['type'];

export class InvalidCallTransitionError extends Error {
  readonly from: CallState;
  readonly event: EventType;

  constructor(from: CallState, event: EventType) {
    super('invalid-call-transition');
    this.name = 'InvalidCallTransitionError';
    this.from = from;
    this.event = event;
  }
}

export class CallNotFoundError extends Error {
  readonly callId: string;

  constructor(callId: string) {
    super('call-not-found');
    this.name = 'CallNotFoundError';
    this.callId = callId;
  }
}

export class ConcurrentCallLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super('concurrent-call-limit');
    this.name = 'ConcurrentCallLimitError';
    this.limit = limit;
  }
}

export const MAX_CONCURRENT_CALLS = 4;

export type CallRegistry = Readonly<Record<string, CallSession>>;

export const emptyCallRegistry: CallRegistry = {};

const TRANSITIONS: Readonly<Record<CallState, Readonly<Partial<Record<EventType, CallState>>>>> = {
  ringing: { answer: 'connecting', reject: 'ended', remoteHangup: 'ended' },
  connecting: { connected: 'active', hangup: 'ended' },
  active: { hold: 'held', hangup: 'ended', remoteHangup: 'ended' },
  held: { resume: 'active', hangup: 'ended', remoteHangup: 'ended' },
  ended: {}
};

export function nextCallState(from: CallState, event: EventType): CallState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) throw new InvalidCallTransitionError(from, event);
  return to;
}

export function activeCalls(registry: CallRegistry): readonly CallSession[] {
  return Object.values(registry).filter((call) => call.state !== 'ended');
}

export function callsForAccount(registry: CallRegistry, accountId: AccountId): readonly CallSession[] {
  return Object.values(registry).filter((call) => call.accountId === accountId);
}

export function incomingCall(
  registry: CallRegistry,
  params: { id: string; accountId: AccountId; remoteIdentity: string }
): CallRegistry {
  if (activeCalls(registry).length >= MAX_CONCURRENT_CALLS) {
    throw new ConcurrentCallLimitError(MAX_CONCURRENT_CALLS);
  }
  const call: CallSession = { ...params, direction: 'inbound', state: 'ringing' };
  return { ...registry, [params.id]: call };
}

export function applyCallEvent(registry: CallRegistry, callId: string, event: CallEvent): CallRegistry {
  const call = Object.hasOwn(registry, callId) ? registry[callId] : undefined;
  if (call === undefined) throw new CallNotFoundError(callId);
  return { ...registry, [callId]: { ...call, state: nextCallState(call.state, event.type) } };
}

export function callStateKey(state: CallState): string {
  return `calls.state.${state}`;
}
