import { describe, expect, it } from 'vitest';
import { createAccount } from '../../src/core/sip/account';
import { AccountValidationError } from '../../src/core/sip/account';
import {
  AccountNotFoundError,
  DuplicateAccountError,
  addAccount,
  emptyAccountStore,
  getAccount,
  listAccounts,
  removeAccount,
  updateAccount
} from '../../src/core/sip/account-store';
import type { SipAccountInput } from '../../src/core/sip/types';

const input = (over: Partial<SipAccountInput> = {}): SipAccountInput => ({
  displayName: 'Work',
  username: 'alice',
  password: 'pw',
  domain: 'sip.example.com',
  ...over
});
const make = (id: string, over: Partial<SipAccountInput> = {}): ReturnType<typeof createAccount> =>
  createAccount(input(over), id);

describe('account store', () => {
  it('starts empty', () => {
    expect(listAccounts(emptyAccountStore)).toEqual([]);
  });

  it('adds immutably', () => {
    const a = make('a');
    const next = addAccount(emptyAccountStore, a);
    expect(next).toEqual({ a });
    expect(emptyAccountStore).toEqual({});
    expect(getAccount(next, 'a')).toBe(a);
  });

  it('rejects a duplicate key, case-insensitively', () => {
    const state = addAccount(emptyAccountStore, make('a'));
    const dup = make('b', { username: 'ALICE', domain: 'SIP.example.com' });
    expect(() => addAccount(state, dup)).toThrow(DuplicateAccountError);
    try {
      addAccount(state, dup);
    } catch (error) {
      expect((error as DuplicateAccountError).messageKey).toBe('accounts.validation.duplicate');
    }
  });

  it('rejects a reused id', () => {
    const state = addAccount(emptyAccountStore, make('a'));
    expect(() => addAccount(state, make('a', { username: 'bob' }))).toThrow(DuplicateAccountError);
  });

  it('accepts same user on a different domain', () => {
    const state = addAccount(emptyAccountStore, make('a'));
    const next = addAccount(state, make('b', { domain: 'other.example.com' }));
    expect(Object.keys(next)).toEqual(['a', 'b']);
  });

  it('getAccount throws AccountNotFoundError with the id', () => {
    expect(() => getAccount(emptyAccountStore, 'zz')).toThrow(AccountNotFoundError);
    try {
      getAccount(emptyAccountStore, 'zz');
    } catch (error) {
      expect((error as AccountNotFoundError).accountId).toBe('zz');
    }
  });

  it('does not find inherited object keys', () => {
    expect(() => getAccount(emptyAccountStore, 'toString')).toThrow(AccountNotFoundError);
  });

  it('removes immutably and throws when missing', () => {
    const state = addAccount(addAccount(emptyAccountStore, make('a')), make('b', { username: 'bob' }));
    const next = removeAccount(state, 'a');
    expect(Object.keys(next)).toEqual(['b']);
    expect(Object.keys(state)).toEqual(['a', 'b']);
    expect(() => removeAccount(next, 'a')).toThrow(AccountNotFoundError);
  });

  it('lists sorted by displayName independent of insertion order', () => {
    let state = addAccount(emptyAccountStore, make('1', { displayName: 'beta', username: 'u1' }));
    state = addAccount(state, make('2', { displayName: 'Alpha', username: 'u2' }));
    state = addAccount(state, make('3', { displayName: 'gamma', username: 'u3' }));
    expect(listAccounts(state).map((a) => a.id)).toEqual(['2', '1', '3']);
  });
});

describe('updateAccount', () => {
  const state = addAccount(
    addAccount(emptyAccountStore, make('a')),
    make('b', { username: 'bob', displayName: 'Home' })
  );

  it('merges the patch, revalidates and rebuilds the uri', () => {
    const next = updateAccount(state, 'a', { username: ' carol ', registerExpires: 120 });
    expect(next['a']).toMatchObject({
      id: 'a',
      username: 'carol',
      registerExpires: 120,
      uri: 'sip:carol@sip.example.com',
      displayName: 'Work'
    });
    expect(state['a']?.username).toBe('alice');
  });

  it('sets and then clears the serverUri override', () => {
    const pinned = updateAccount(state, 'a', { serverUri: ' tcp://pbx:5060 ' });
    expect(pinned['a']?.serverUri).toBe('tcp://pbx:5060');
    const cleared = updateAccount(pinned, 'a', { serverUri: '' });
    expect(cleared['a'] !== undefined && Object.hasOwn(cleared['a'], 'serverUri')).toBe(false);
  });

  it('rejects an unsupported serverUri in a patch', () => {
    expect(() => updateAccount(state, 'a', { serverUri: 'ftp://pbx' })).toThrow(AccountValidationError);
  });

  it('throws AccountNotFoundError', () => {
    expect(() => updateAccount(state, 'x', {})).toThrow(AccountNotFoundError);
  });

  it('throws AccountValidationError for an invalid patch', () => {
    expect(() => updateAccount(state, 'a', { registerExpires: 5 })).toThrow(AccountValidationError);
  });

  it('throws DuplicateAccountError when colliding with another account', () => {
    expect(() => updateAccount(state, 'a', { username: 'BOB' })).toThrow(DuplicateAccountError);
  });

  it('allows an account to keep its own key', () => {
    const next = updateAccount(state, 'a', { displayName: 'Renamed' });
    expect(next['a']?.displayName).toBe('Renamed');
  });
});
