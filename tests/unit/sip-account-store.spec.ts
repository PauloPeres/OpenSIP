import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/core/sip/account';
import { AccountValidationError } from '../../src/core/sip/account';
import {
  AccountNotFoundError,
  DuplicateAccountError,
  addAccount,
  emptyAccountStore,
  enabledAccounts,
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

describe('account switch', () => {
  const build = (): ReturnType<typeof addAccount> => {
    let state = addAccount(emptyAccountStore, make('1', { displayName: 'beta', username: 'u1' }));
    state = addAccount(state, make('2', { displayName: 'Alpha', username: 'u2', enabled: false }));
    return addAccount(state, make('3', { displayName: 'gamma', username: 'u3' }));
  };

  it('keeps disabled accounts in listAccounts', () => {
    expect(listAccounts(build()).map((a) => a.id)).toEqual(['2', '1', '3']);
  });

  it('lists only enabled accounts, in the same order as listAccounts', () => {
    expect(enabledAccounts(build()).map((a) => a.id)).toEqual(['1', '3']);
  });

  it('lists nothing from an empty store', () => {
    expect(enabledAccounts(emptyAccountStore)).toEqual([]);
  });

  it('turns an account off and on again without clashing with itself', () => {
    const off = updateAccount(build(), '1', { enabled: false });
    expect(getAccount(off, '1').enabled).toBe(false);
    expect(enabledAccounts(off).map((a) => a.id)).toEqual(['3']);
    const on = updateAccount(off, '1', { enabled: true });
    expect(getAccount(on, '1').enabled).toBe(true);
    expect(enabledAccounts(on).map((a) => a.id)).toEqual(['1', '3']);
  });

  it('keeps the switch when other fields are edited', () => {
    const edited = updateAccount(build(), '2', { displayName: 'Renamed' });
    expect(getAccount(edited, '2').enabled).toBe(false);
  });
});

describe('account store error shapes', () => {
  it('DuplicateAccountError carries name, message and messageKey', () => {
    const error = new DuplicateAccountError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DuplicateAccountError');
    expect(error.message).toBe('duplicate-account');
    expect(error.messageKey).toBe('accounts.validation.duplicate');
  });

  it('AccountNotFoundError carries name, message and accountId', () => {
    const error = new AccountNotFoundError('zz');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AccountNotFoundError');
    expect(error.message).toBe('account-not-found');
    expect(error.accountId).toBe('zz');
  });

  it('getAccount throws an error whose name, message and id are exact', () => {
    expect(() => getAccount(emptyAccountStore, 'zz')).toThrow(
      expect.objectContaining({ name: 'AccountNotFoundError', message: 'account-not-found', accountId: 'zz' })
    );
  });

  it('addAccount throws an error whose name and message are exact', () => {
    const state = addAccount(emptyAccountStore, make('a'));
    expect(() => addAccount(state, make('b'))).toThrow(
      expect.objectContaining({ name: 'DuplicateAccountError', message: 'duplicate-account' })
    );
  });
});

describe('account store uniqueness', () => {
  const a = make('a');
  const b = make('b', { username: 'bob' });
  const c = make('c', { username: 'carol', domain: 'other.example.com' });

  it('adds a distinct account to a populated store and keeps every entry', () => {
    const next = addAccount(addAccount(emptyAccountStore, a), b);
    expect(next).toEqual({ a, b });
  });

  it('adds a third account that differs from each existing one', () => {
    const next = addAccount(addAccount(addAccount(emptyAccountStore, a), b), c);
    expect(Object.keys(next)).toEqual(['a', 'b', 'c']);
  });

  it('detects a clash with the LAST account, not only the first', () => {
    const state = addAccount(addAccount(emptyAccountStore, a), b);
    expect(() => addAccount(state, make('d', { username: 'BOB' }))).toThrow(DuplicateAccountError);
  });

  it('detects a clash with the FIRST account when others differ', () => {
    const state = addAccount(addAccount(emptyAccountStore, a), b);
    expect(() => addAccount(state, make('d', { username: 'ALICE' }))).toThrow(DuplicateAccountError);
  });

  it('a clash needs both user and domain: same domain, different user is fine', () => {
    const state = addAccount(emptyAccountStore, a);
    expect(() => addAccount(state, make('d', { username: 'zed' }))).not.toThrow();
  });

  it('a clash needs a different id: re-adding the same key under the same id is a duplicate-id error, not a no-op', () => {
    const state = addAccount(emptyAccountStore, a);
    expect(() => addAccount(state, a)).toThrow(DuplicateAccountError);
  });

  it('updating an account keeps its own key without a clash among several accounts', () => {
    const state = addAccount(addAccount(emptyAccountStore, a), b);
    const next = updateAccount(state, 'b', { password: 'new' });
    expect(next['b']?.password).toBe('new');
    expect(next['a']).toBe(a);
  });
});

describe('updateAccount', () => {
  // Built per test (not at collection time) so a mutated addAccount fails a test instead of the whole file.
  let state = emptyAccountStore;
  beforeEach(() => {
    state = addAccount(addAccount(emptyAccountStore, make('a')), make('b', { username: 'bob', displayName: 'Home' }));
  });

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
