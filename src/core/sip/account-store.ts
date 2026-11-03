import { accountKey, createAccount } from './account';
import type { AccountId, SipAccount, SipAccountInput } from './types';

export class DuplicateAccountError extends Error {
  readonly messageKey = 'accounts.validation.duplicate' as const;

  constructor() {
    super('duplicate-account');
    this.name = 'DuplicateAccountError';
  }
}

export class AccountNotFoundError extends Error {
  readonly accountId: AccountId;

  constructor(accountId: AccountId) {
    super('account-not-found');
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

export type AccountStoreState = Readonly<Record<AccountId, SipAccount>>;

export const emptyAccountStore: AccountStoreState = {};

export function getAccount(state: AccountStoreState, id: AccountId): SipAccount {
  const account = Object.hasOwn(state, id) ? state[id] : undefined;
  if (account === undefined) throw new AccountNotFoundError(id);
  return account;
}

function assertUnique(state: AccountStoreState, account: SipAccount): void {
  const key = accountKey(account);
  const clash = Object.values(state).some((a) => a.id !== account.id && accountKey(a) === key);
  if (clash) throw new DuplicateAccountError();
}

export function addAccount(state: AccountStoreState, account: SipAccount): AccountStoreState {
  if (Object.hasOwn(state, account.id)) throw new DuplicateAccountError();
  assertUnique(state, account);
  return { ...state, [account.id]: account };
}

export function updateAccount(
  state: AccountStoreState,
  id: AccountId,
  patch: Partial<SipAccountInput>
): AccountStoreState {
  const updated = createAccount({ ...getAccount(state, id), ...patch }, id);
  assertUnique(state, updated);
  return { ...state, [id]: updated };
}

export function removeAccount(state: AccountStoreState, id: AccountId): AccountStoreState {
  getAccount(state, id);
  return Object.fromEntries(Object.entries(state).filter(([key]) => key !== id));
}

export function listAccounts(state: AccountStoreState): readonly SipAccount[] {
  return Object.values(state).sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));
}
