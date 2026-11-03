import { describe, expect, it } from 'vitest';
import {
  CallNotFoundError,
  ConcurrentCallLimitError,
  InvalidCallTransitionError,
  MAX_CONCURRENT_CALLS,
  activeCalls,
  applyCallEvent,
  callStateKey,
  callsForAccount,
  emptyCallRegistry,
  incomingCall,
  nextCallState
} from '../../src/core/sip/call';
import type { CallEvent, CallRegistry } from '../../src/core/sip/call';
import type { CallState } from '../../src/core/sip/types';

type EventType = CallEvent['type'];
const ring = (registry: CallRegistry, id: string, accountId = 'acc'): CallRegistry =>
  incomingCall(registry, { id, accountId, remoteIdentity: `sip:${id}@x.com` });

const allowed: readonly (readonly [CallState, EventType, CallState])[] = [
  ['ringing', 'answer', 'connecting'],
  ['ringing', 'reject', 'ended'],
  ['ringing', 'remoteHangup', 'ended'],
  ['connecting', 'connected', 'active'],
  ['connecting', 'hangup', 'ended'],
  ['active', 'hold', 'held'],
  ['held', 'resume', 'active'],
  ['active', 'hangup', 'ended'],
  ['active', 'remoteHangup', 'ended'],
  ['held', 'hangup', 'ended'],
  ['held', 'remoteHangup', 'ended']
];
const states: CallState[] = ['ringing', 'connecting', 'active', 'held', 'ended'];
const events: EventType[] = [
  'answer',
  'reject',
  'connected',
  'hangup',
  'hold',
  'resume',
  'remoteHangup'
];
const invalid = states.flatMap((s) =>
  events
    .filter((e) => !allowed.some(([from, ev]) => from === s && ev === e))
    .map((e) => [s, e] as const)
);

describe('nextCallState', () => {
  it.each(allowed)('%s + %s -> %s', (from, event, to) => {
    expect(nextCallState(from, event)).toBe(to);
  });

  it.each(invalid)('%s + %s throws', (from, event) => {
    expect(() => nextCallState(from, event)).toThrow(InvalidCallTransitionError);
    try {
      nextCallState(from, event);
    } catch (error) {
      expect(error).toMatchObject({ from, event, name: 'InvalidCallTransitionError' });
    }
  });

  it('has 11 valid and 24 invalid pairs', () => {
    expect(allowed).toHaveLength(11);
    expect(invalid).toHaveLength(24);
  });
});

describe('incomingCall', () => {
  it('registers a ringing inbound call', () => {
    const registry = ring(emptyCallRegistry, 'c1', 'acc1');
    expect(registry['c1']).toEqual({
      id: 'c1',
      accountId: 'acc1',
      remoteIdentity: 'sip:c1@x.com',
      direction: 'inbound',
      state: 'ringing'
    });
    expect(emptyCallRegistry).toEqual({});
  });

  it('allows calls up to the limit and throws beyond it', () => {
    expect(MAX_CONCURRENT_CALLS).toBe(4);
    let registry = emptyCallRegistry;
    for (let i = 0; i < MAX_CONCURRENT_CALLS - 1; i += 1) registry = ring(registry, `c${i}`);
    registry = ring(registry, 'last');
    expect(activeCalls(registry)).toHaveLength(MAX_CONCURRENT_CALLS);
    expect(() => ring(registry, 'over')).toThrow(ConcurrentCallLimitError);
    try {
      ring(registry, 'over');
    } catch (error) {
      expect((error as ConcurrentCallLimitError).limit).toBe(4);
    }
  });

  it('frees a slot when a call ends', () => {
    let registry = emptyCallRegistry;
    for (let i = 0; i < MAX_CONCURRENT_CALLS; i += 1) registry = ring(registry, `c${i}`);
    registry = applyCallEvent(registry, 'c0', { type: 'reject' });
    const next = ring(registry, 'fresh');
    expect(activeCalls(next)).toHaveLength(MAX_CONCURRENT_CALLS);
    expect(next['c0']?.state).toBe('ended');
  });
});

describe('applyCallEvent', () => {
  it('applies a transition immutably', () => {
    const before = ring(emptyCallRegistry, 'c1');
    const after = applyCallEvent(before, 'c1', { type: 'answer' });
    expect(after['c1']?.state).toBe('connecting');
    expect(before['c1']?.state).toBe('ringing');
    expect(after['c1']).toMatchObject({ id: 'c1', accountId: 'acc', direction: 'inbound' });
  });

  it('throws CallNotFoundError with the id', () => {
    expect(() => applyCallEvent(emptyCallRegistry, 'nope', { type: 'answer' })).toThrow(
      CallNotFoundError
    );
    try {
      applyCallEvent(emptyCallRegistry, 'nope', { type: 'answer' });
    } catch (error) {
      expect(error).toMatchObject({ callId: 'nope', name: 'CallNotFoundError' });
    }
  });

  it('does not find inherited object keys', () => {
    expect(() => applyCallEvent(emptyCallRegistry, 'toString', { type: 'answer' })).toThrow(
      CallNotFoundError
    );
  });

  it('throws InvalidCallTransitionError for a bad event', () => {
    const registry = ring(emptyCallRegistry, 'c1');
    expect(() => applyCallEvent(registry, 'c1', { type: 'hold' })).toThrow(
      InvalidCallTransitionError
    );
  });

  it('walks a full call lifecycle', () => {
    const events: CallEvent[] = [
      { type: 'answer' },
      { type: 'connected' },
      { type: 'hold' },
      { type: 'resume' },
      { type: 'hangup' }
    ];
    const end = events.reduce((r, e) => applyCallEvent(r, 'c1', e), ring(emptyCallRegistry, 'c1'));
    expect(end['c1']?.state).toBe('ended');
  });
});

describe('queries', () => {
  it('activeCalls excludes ended calls', () => {
    let registry = ring(ring(emptyCallRegistry, 'a'), 'b');
    registry = applyCallEvent(registry, 'a', { type: 'reject' });
    expect(activeCalls(registry).map((c) => c.id)).toEqual(['b']);
  });

  it('callsForAccount filters by account, including ended calls', () => {
    let registry = ring(ring(ring(emptyCallRegistry, 'a', 'one'), 'b', 'two'), 'c', 'one');
    registry = applyCallEvent(registry, 'a', { type: 'reject' });
    expect(callsForAccount(registry, 'one').map((c) => c.id)).toEqual(['a', 'c']);
    expect(callsForAccount(registry, 'none')).toEqual([]);
  });

  it('callStateKey maps to an i18n key', () => {
    expect(callStateKey('held')).toBe('calls.state.held');
    expect(callStateKey('ringing')).toBe('calls.state.ringing');
  });
});
