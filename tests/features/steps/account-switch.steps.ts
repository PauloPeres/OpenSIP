import assert from 'node:assert/strict';
import { Before, Given, Then, When } from '@cucumber/cucumber';
import { createAccount, restoreAccount } from '../../../src/core/sip/account';
import {
  addAccount,
  emptyAccountStore,
  enabledAccounts,
  listAccounts,
  updateAccount
} from '../../../src/core/sip/account-store';
import type { AccountStoreState } from '../../../src/core/sip/account-store';

interface SwitchWorld {
  store: AccountStoreState;
}

const world: SwitchWorld = { store: emptyAccountStore };

Before(() => {
  world.store = emptyAccountStore;
});

const record = (user: string, domain: string): Parameters<typeof createAccount>[0] => ({
  displayName: user,
  username: user,
  password: 'pw',
  domain
});

Given('a switchboard holding a new account {string} at {string}', (user: string, domain: string) => {
  world.store = addAccount(world.store, createAccount(record(user, domain), user));
});

Given(
  'a switchboard restored from an old record for {string} at {string} without a switch',
  (user: string, domain: string) => {
    const old: Omit<ReturnType<typeof createAccount>, 'enabled'> & { enabled?: boolean } = createAccount(
      record(user, domain),
      user
    );
    delete old.enabled;
    world.store = addAccount(world.store, restoreAccount(old));
  }
);

When('the user flips the {string} switch off', (id: string) => {
  world.store = updateAccount(world.store, id, { enabled: false });
});

When('the user flips the {string} switch on', (id: string) => {
  world.store = updateAccount(world.store, id, { enabled: true });
});

Then('the account {string} is switched on', (id: string) => {
  assert.equal(world.store[id]?.enabled, true);
});

Then('the account {string} is switched off', (id: string) => {
  assert.equal(world.store[id]?.enabled, false);
});

Then('the switchboard counts {int} listed and {int} switched-on accounts', (listed: number, on: number) => {
  assert.equal(listAccounts(world.store).length, listed);
  assert.equal(enabledAccounts(world.store).length, on);
});
