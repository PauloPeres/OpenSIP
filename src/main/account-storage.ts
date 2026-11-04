import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { parseHistory } from '@core/history';
import type { CallRecord } from '@core/history';
import { isSupportedLocale } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { emptyAccountStore, restoreAccount } from '@core/sip';
import type { AccountStoreState, SipAccount } from '@core/sip';
import { log } from './windows';

/*
 * Passwords are encrypted with Electron's safeStorage (OS keychain backed) when
 * available and fall back to plaintext otherwise. A dedicated keytar/credential
 * vault is the next step; the on-disk shape already isolates the password field.
 *
 * Call history lives in the same file but is deliberately NOT encrypted. It is
 * personal (who was called, and when) but it is not a credential, and the file
 * is written 0600 inside the user's own profile directory, which is the same
 * protection the OS gives their other documents. Encrypting it with the
 * keychain would make it unreadable whenever the keychain entry changes (an
 * ad-hoc signed build gets a new one on every build), silently losing the
 * history, and would suggest a protection against local snooping that
 * safeStorage cannot give against a process already running as the user.
 * The cap (MAX_HISTORY_ENTRIES) and "Clear history" bound what is kept.
 */

export interface PersistedState {
  readonly accounts: AccountStoreState;
  readonly locale?: Locale;
  /** Raw SIP capture; persisted so a diagnosis survives a restart. */
  readonly debugLogging?: boolean;
  /** The User-Agent setting; blank means the default. Absent until the user has chosen, so the environment can seed it. */
  readonly userAgent?: string;
  /** Newest first. Absent in files written before history existed. */
  readonly history?: readonly CallRecord[];
}

type StoredAccount = Omit<SipAccount, 'password' | 'enabled'> & {
  /** Absent in files written before the on/off switch existed. */
  readonly enabled?: boolean;
  readonly password: string;
  readonly passwordEncrypted: boolean;
};

interface StoredFile {
  readonly accounts?: Readonly<Record<string, StoredAccount>>;
  readonly locale?: string;
  readonly debugLogging?: boolean;
  readonly userAgent?: unknown;
  readonly history?: unknown;
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
  return restoreAccount({ ...rest, password: plain });
}

function decodeAll(stored: Readonly<Record<string, StoredAccount>>): AccountStoreState {
  const entries = Object.entries(stored).map(([id, account]) => [id, decode(account)] as const);
  return Object.fromEntries(entries);
}

function toPersisted(file: StoredFile): PersistedState {
  const accounts = file.accounts ? decodeAll(file.accounts) : emptyAccountStore;
  const locale = file.locale !== undefined && isSupportedLocale(file.locale) ? { locale: file.locale } : {};
  const debugLogging = typeof file.debugLogging === 'boolean' ? { debugLogging: file.debugLogging } : {};
  const userAgent = typeof file.userAgent === 'string' ? { userAgent: file.userAgent } : {};
  return { accounts, ...locale, ...debugLogging, ...userAgent, history: parseHistory(file.history) };
}

export async function loadState(): Promise<PersistedState> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    return toPersisted(JSON.parse(raw) as StoredFile);
  } catch (error) {
    log('warn', `starting with empty account store: ${String(error)}`);
    return { accounts: emptyAccountStore, history: [] };
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  const accounts = Object.fromEntries(
    Object.entries(state.accounts).map(([id, account]) => [id, encode(account)])
  );
  const payload: StoredFile = {
    accounts,
    ...(state.locale === undefined ? {} : { locale: state.locale }),
    ...(state.debugLogging === undefined ? {} : { debugLogging: state.debugLogging }),
    ...(state.userAgent === undefined ? {} : { userAgent: state.userAgent }),
    history: state.history ?? []
  };
  await mkdir(dirname(filePath()), { recursive: true });
  await writeFile(filePath(), JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}
