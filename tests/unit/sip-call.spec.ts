import { describe, expect, it } from 'vitest';
import {
  CallNotFoundError,
  ConcurrentCallLimitError,
  InvalidCallTargetError,
  InvalidCallTransitionError,
  MAX_CONCURRENT_CALLS,
  activeCalls,
  applyCallEvent,
  callStateKey,
  callsForAccount,
  emptyCallRegistry,
  incomingCall,
  nextCallState,
  normaliseTarget,
  outgoingCall
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
  ['connecting', 'remoteHangup', 'ended'],
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

  it('has 12 valid and 23 invalid pairs', () => {
    expect(allowed).toHaveLength(12);
    expect(invalid).toHaveLength(23);
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

const dial = (registry: CallRegistry, id: string, accountId = 'acc'): CallRegistry =>
  outgoingCall(registry, { id, accountId, target: `sip:${id}@x.com` });

describe('outgoingCall', () => {
  it('registers a connecting outbound call to the target', () => {
    const registry = dial(emptyCallRegistry, 'o1', 'acc1');
    expect(registry['o1']).toEqual({
      id: 'o1',
      accountId: 'acc1',
      remoteIdentity: 'sip:o1@x.com',
      direction: 'outbound',
      state: 'connecting'
    });
    expect(emptyCallRegistry).toEqual({});
  });

  it('shares the concurrent limit with inbound calls', () => {
    let registry = ring(ring(emptyCallRegistry, 'a'), 'b');
    registry = dial(dial(registry, 'c'), 'd');
    expect(activeCalls(registry)).toHaveLength(MAX_CONCURRENT_CALLS);
    expect(() => dial(registry, 'e')).toThrow(ConcurrentCallLimitError);
    expect(() => ring(registry, 'f')).toThrow(ConcurrentCallLimitError);
    try {
      dial(registry, 'e');
    } catch (error) {
      expect((error as ConcurrentCallLimitError).limit).toBe(4);
    }
  });

  it('allows a fourth call and frees a slot when one ends', () => {
    let registry = emptyCallRegistry;
    for (let i = 0; i < MAX_CONCURRENT_CALLS - 1; i += 1) registry = dial(registry, `c${i}`);
    expect(activeCalls(dial(registry, 'last'))).toHaveLength(MAX_CONCURRENT_CALLS);
    registry = dial(registry, 'last');
    registry = applyCallEvent(registry, 'c0', { type: 'remoteHangup' });
    expect(activeCalls(dial(registry, 'fresh'))).toHaveLength(MAX_CONCURRENT_CALLS);
  });

  it('becomes active on connected', () => {
    const registry = applyCallEvent(dial(emptyCallRegistry, 'o1'), 'o1', { type: 'connected' });
    expect(registry['o1']?.state).toBe('active');
    expect(registry['o1']?.direction).toBe('outbound');
  });

  it.each(['hangup', 'remoteHangup'] as const)('ends on %s while connecting', (type) => {
    const registry = applyCallEvent(dial(emptyCallRegistry, 'o1'), 'o1', { type });
    expect(registry['o1']?.state).toBe('ended');
  });

  it('cannot be answered or rejected as if it were ringing', () => {
    const registry = dial(emptyCallRegistry, 'o1');
    expect(() => applyCallEvent(registry, 'o1', { type: 'answer' })).toThrow(InvalidCallTransitionError);
    expect(() => applyCallEvent(registry, 'o1', { type: 'reject' })).toThrow(InvalidCallTransitionError);
  });
});

describe('normaliseTarget', () => {
  const domain = 'pbx.example.com';
  it.each([
    ['1001', 'sip:1001@pbx.example.com'],
    ['  1001  ', 'sip:1001@pbx.example.com'],
    ['sip:x@y.com', 'sip:x@y.com'],
    ['  sip:x@y.com ', 'sip:x@y.com'],
    ['SIP:x@y.com', 'SIP:x@y.com'],
    ['sips:x@y.com', 'sips:x@y.com'],
    ['alice@other.org', 'sip:alice@other.org'],
    ['sip:1001', 'sip:1001@pbx.example.com'],
    ['+55 11 99999-0000', 'sip:+5511999990000@pbx.example.com'],
    ['(11) 99999-0000', 'sip:11999990000@pbx.example.com'],
    ['+1 (415) 555-2671', 'sip:+14155552671@pbx.example.com'],
    ['11.9999.0000', 'sip:11.9999.0000@pbx.example.com'],
    ['*97', 'sip:*97@pbx.example.com'],
    ['#31#', 'sip:#31#@pbx.example.com'],
    ['\t1001\n', 'sip:1001@pbx.example.com'],
    ['bob', 'sip:bob@pbx.example.com'],
    ['sip:+55 11 9999@x.com', 'sip:+55 11 9999@x.com']
  ])('normalises %j to %s', (input, expected) => {
    expect(normaliseTarget(input, domain)).toBe(expected);
  });

  it.each(['', '   ', '\t\n', '---', '( ) - ', 'sip:', '  sip:  ', '@', '+'])(
    'rejects %j',
    (input) => {
      expect(() => normaliseTarget(input, domain)).toThrow(InvalidCallTargetError);
    }
  );

  it('keeps the offending target and a short identifier on the error', () => {
    try {
      normaliseTarget('  ', domain);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ target: '  ', name: 'InvalidCallTargetError', message: 'invalid-call-target' });
    }
  });
});
