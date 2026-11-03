import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { isSupportedLocale } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { emptyAccountStore } from '@core/sip';
import type { AccountStoreState, SipAccount } from '@core/sip';
import { log } from './windows';

/*
 * Passwords are encrypted with Electron's safeStorage (OS keychain backed) when
 * available and fall back to plaintext otherwise. A dedicated keytar/credential
 * vault is the next step; the on-disk shape already isolates the password field.
 */

export interface PersistedState {
  readonly accounts: AccountStoreState;
  readonly locale?: Locale;
}

type StoredAccount = Omit<SipAccount, 'password'> & {
  readonly password: string;
  readonly passwordEncrypted: boolean;
};

interface StoredFile {
  readonly accounts?: Readonly<Record<string, StoredAccount>>;
  readonly locale?: string;
}

const filePath = (): string => join(app.getPath('userData'), 'accounts.json');

function encode(account: SipAccount): StoredAccount {
  if (safeStorage.isEncryptionAvailable()) {
    const password = safeStorage.encryptString(account.password).toString('base64');
    return { ...account, password, passwordEncrypted: true };
  }
  log('warn', 'safeStorage unavailable; storing password in plaintext');
  return { ...account, passwordEncrypted: false };
}

function decode(stored: StoredAccount): SipAccount {
  const { passwordEncrypted, password, ...rest } = stored;
  const plain = passwordEncrypted
    ? safeStorage.decryptString(Buffer.from(password, 'base64'))
    : password;
  return { ...rest, password: plain };
}

function decodeAll(stored: Readonly<Record<string, StoredAccount>>): AccountStoreState {
  const entries = Object.entries(stored).map(([id, account]) => [id, decode(account)] as const);
  return Object.fromEntries(entries);
}

function toPersisted(file: StoredFile): PersistedState {
  const accounts = file.accounts ? decodeAll(file.accounts) : emptyAccountStore;
  return file.locale !== undefined && isSupportedLocale(file.locale)
    ? { accounts, locale: file.locale }
    : { accounts };
}

export async function loadState(): Promise<PersistedState> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    return toPersisted(JSON.parse(raw) as StoredFile);
  } catch (error) {
    log('warn', `starting with empty account store: ${String(error)}`);
    return { accounts: emptyAccountStore };
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  const accounts = Object.fromEntries(
    Object.entries(state.accounts).map(([id, account]) => [id, encode(account)])
  );
  const payload: StoredFile = state.locale === undefined ? { accounts } : { accounts, locale: state.locale };
  await mkdir(dirname(filePath()), { recursive: true });
  await writeFile(filePath(), JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}
