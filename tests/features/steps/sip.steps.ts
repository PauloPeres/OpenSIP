import assert from 'node:assert/strict';
import { Before, Given, Then, When } from '@cucumber/cucumber';
import {
  ConcurrentCallLimitError,
  DuplicateAccountError,
  MAX_CONCURRENT_CALLS,
  activeCalls,
  addAccount,
  applyCallEvent,
  canRetry,
  createAccount,
  emptyAccountStore,
  emptyCallRegistry,
  incomingCall,
  initialRegistration,
  listAccounts,
  reduceRegistration
} from '../../../src/core/sip/index';
import type {
  AccountStoreState,
  CallEvent,
  CallRegistry,
  RegistrationEvent,
  RegistrationSnapshot
} from '../../../src/core/sip/index';

interface World {
  accounts: AccountStoreState;
  registrations: Record<string, RegistrationSnapshot>;
  calls: CallRegistry;
  error: unknown;
}

const world: World = {
  accounts: emptyAccountStore,
  registrations: {},
  calls: emptyCallRegistry,
  error: undefined
};

Before(() => {
  world.accounts = emptyAccountStore;
  world.registrations = {};
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

const addNamed = (name: string, user: string, domain: string, serverUri?: string): void => {
  const account = createAccount(
    {
      displayName: name,
      username: user,
      password: 'pw',
      domain,
      ...(serverUri === undefined ? {} : { serverUri })
    },
    name
  );
  world.accounts = addAccount(world.accounts, account);
  world.registrations[name] = initialRegistration;
};

const regEvent = (name: string, event: RegistrationEvent): void => {
  const current = world.registrations[name] ?? initialRegistration;
  world.registrations[name] = reduceRegistration(current, event);
};

const registerAll = (): void => {
  listAccounts(world.accounts).forEach((a) => regEvent(a.id, { type: 'register' }));
};

const acceptAll = (): void => {
  listAccounts(world.accounts).forEach((a) => regEvent(a.id, { type: 'registered' }));
};

const callEvent = (id: string, type: CallEvent['type']): void => {
  world.calls = applyCallEvent(world.calls, id, { type });
};

const ring = (id: string, accountId: string, remoteIdentity: string): void => {
  world.calls = incomingCall(world.calls, { id, accountId, remoteIdentity });
};

Given('no SIP accounts are configured', () => {
  assert.equal(listAccounts(world.accounts).length, 0);
});

Given('the account {string} for {string} on {string} is configured', (name: string, user: string, domain: string) => {
  addNamed(name, user, domain);
});

Given('the account {string} for {string} on {string} is registered', (name: string, user: string, domain: string) => {
  addNamed(name, user, domain);
  regEvent(name, { type: 'register' });
  regEvent(name, { type: 'registered' });
});

When('I add the account {string} for {string} on {string}', (name: string, user: string, domain: string) => {
  attempt(() => addNamed(name, user, domain));
});

When(
  'I add the account {string} for {string} on {string} pinned to the server {string}',
  (name: string, user: string, domain: string, serverUri: string) => {
    attempt(() => addNamed(name, user, domain, serverUri));
  }
);

Then('the account {string} is pinned to the server {string}', (name: string, serverUri: string) => {
  const account = listAccounts(world.accounts).find((a) => a.id === name);
  assert.equal(account?.serverUri, serverUri);
});

Then('the account {string} discovers its transport automatically', (name: string) => {
  const account = listAccounts(world.accounts).find((a) => a.id === name);
  assert.ok(account !== undefined);
  assert.equal(Object.hasOwn(account, 'serverUri'), false);
});

When('I register every account', registerAll);
When('the server accepts every registration', acceptAll);

When('the server accepts the registration of {string}', (name: string) => {
  regEvent(name, { type: 'registered' });
});

When('the server rejects the registration of {string} with {string}', (name: string, reason: string) => {
  regEvent(name, { type: 'failed', reason });
});

When('I retry the registration of {string}', (name: string) => {
  regEvent(name, { type: 'retry' });
});

Then('the account {string} is {string}', (name: string, state: string) => {
  assert.equal(world.registrations[name]?.state, state);
});

Then('{int} accounts are configured', (count: number) => {
  assert.equal(listAccounts(world.accounts).length, count);
});

Then('the operation is rejected with {string}', (messageKey: string) => {
  assert.ok(world.error instanceof DuplicateAccountError);
  assert.equal(world.error.messageKey, messageKey);
});

Then('the account {string} can be retried within {int} attempts', (name: string, max: number) => {
  assert.equal(canRetry(world.registrations[name] ?? initialRegistration, max), true);
});

Then('the account {string} can not be retried within {int} attempts', (name: string, max: number) => {
  assert.equal(canRetry(world.registrations[name] ?? initialRegistration, max), false);
});

Given('{int} calls are ringing on {string}', (count: number, accountId: string) => {
  Array.from({ length: count }, (_, i) => i + 1).forEach((n) => {
    ring(`call-${n}`, accountId, `sip:caller${n}@example.com`);
  });
});

When('a call {string} arrives on {string} from {string}', (id: string, accountId: string, remote: string) => {
  attempt(() => ring(id, accountId, remote));
});

When('I answer the call {string}', (id: string) => {
  callEvent(id, 'answer');
});

When('the media of the call {string} connects', (id: string) => {
  callEvent(id, 'connected');
});

When('I hang up the call {string}', (id: string) => {
  callEvent(id, 'hangup');
});

When('I reject the call {string}', (id: string) => {
  callEvent(id, 'reject');
  world.error = undefined;
});

Then('the call {string} is {string}', (id: string, state: string) => {
  assert.equal(world.calls[id]?.state, state);
});

Then('{int} calls are active', (count: number) => {
  assert.equal(activeCalls(world.calls).length, count);
});

Then('the call is refused because {int} concurrent calls are already in progress', (limit: number) => {
  assert.ok(world.error instanceof ConcurrentCallLimitError);
  assert.equal(world.error.limit, limit);
  assert.equal(limit, MAX_CONCURRENT_CALLS);
});
