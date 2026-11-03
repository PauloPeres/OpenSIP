import assert from 'node:assert/strict';
import { Before, Given, Then, When } from '@cucumber/cucumber';
import {
  ConcurrentCallLimitError,
  InvalidCallTargetError,
  MAX_CONCURRENT_CALLS,
  activeCalls,
  applyCallEvent,
  emptyCallRegistry,
  normaliseTarget,
  outgoingCall
} from '../../../src/core/sip/index';
import type { CallEvent, CallRegistry } from '../../../src/core/sip/index';

interface OutboundWorld {
  domains: Record<string, string>;
  calls: CallRegistry;
  error: unknown;
}

const world: OutboundWorld = { domains: {}, calls: emptyCallRegistry, error: undefined };

Before(() => {
  world.domains = {};
  world.calls = emptyCallRegistry;
  world.error = undefined;
});

const attempt = (action: () => void): void => {
  try {
    action();
  } catch (error) {
    world.error = error;
  }
};

const dial = (id: string, account: string, target: string): void => {
  const domain = world.domains[account] ?? '';
  world.calls = outgoingCall(world.calls, {
    id,
    accountId: account,
    target: normaliseTarget(target, domain)
  });
};

const send = (id: string, event: CallEvent): void => {
  world.calls = applyCallEvent(world.calls, id, event);
};

Given('the outbound account {string} serves the domain {string}', (name: string, domain: string) => {
  world.domains[name] = domain;
});

Given('{int} outbound calls are in progress on {string}', (count: number, account: string) => {
  for (let i = 1; i <= count; i += 1) dial(`out-${i}`, account, `sip:peer${i}@example.com`);
});

When('I place the outbound call {string} to {string} from {string}', (id: string, target: string, account: string) => {
  attempt(() => dial(id, account, target));
});

When('the far end answers the outbound call {string}', (id: string) => {
  send(id, { type: 'connected' });
});

When('the far end hangs up the outbound call {string}', (id: string) => {
  send(id, { type: 'remoteHangup' });
});

When('I end the outbound call {string}', (id: string) => {
  send(id, { type: 'hangup' });
});

Then('the outbound call {string} is {string}', (id: string, state: string) => {
  assert.equal(world.calls[id]?.state, state);
});

Then('the outbound call {string} goes to {string}', (id: string, target: string) => {
  assert.equal(world.calls[id]?.direction, 'outbound');
  assert.equal(world.calls[id]?.remoteIdentity, target);
});

Then('no outbound calls are active', () => {
  assert.equal(activeCalls(world.calls).length, 0);
});

Then('the dial is refused because the target is invalid', () => {
  assert.ok(world.error instanceof InvalidCallTargetError);
});

Then('the dial is refused because {int} concurrent calls are already in progress', (limit: number) => {
  assert.ok(world.error instanceof ConcurrentCallLimitError);
  assert.equal(world.error.limit, limit);
  assert.equal(MAX_CONCURRENT_CALLS, limit);
});
