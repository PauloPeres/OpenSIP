import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAccountStore } from '../../src/core/sip';
import type { CallRecord } from '../../src/core/history';

const dir = { current: '' };

vi.mock('electron', () => ({
  app: { getPath: (): string => dir.current },
  safeStorage: { isEncryptionAvailable: (): boolean => false }
}));
vi.mock('../../src/main/windows', () => ({ log: (): void => undefined }));

const { loadState, saveState } = await import('../../src/main/account-storage');

const record: CallRecord = {
  id: 'c1', accountId: 'acc1', direction: 'inbound', remoteIdentity: 'Alice',
  startedAt: 1, endedAt: 2, outcome: 'missed'
};
const file = (): string => join(dir.current, 'accounts.json');

beforeEach(async () => { dir.current = await mkdtemp(join(tmpdir(), 'opensip-history-')); });
afterEach(async () => { await rm(dir.current, { recursive: true, force: true }); });

describe('history persistence', () => {
  it('loads a file written before history existed, with no history key', async () => {
    await writeFile(file(), JSON.stringify({ accounts: {}, locale: 'en', debugLogging: true }));
    const state = await loadState();
    expect(state.history).toEqual([]);
    expect(state.locale).toBe('en');
    expect(state.debugLogging).toBe(true);
  });

  it('starts empty, not crashed, when there is no file at all', async () => {
    expect((await loadState()).history).toEqual([]);
  });

  it('starts empty when the file is not JSON', async () => {
    await writeFile(file(), '{not json');
    const state = await loadState();
    expect(state.history).toEqual([]);
    expect(state.accounts).toEqual(emptyAccountStore);
  });

  it('starts empty when history is not a list', async () => {
    await writeFile(file(), JSON.stringify({ accounts: {}, history: 'oops' }));
    expect((await loadState()).history).toEqual([]);
  });

  it('keeps the readable entries when some are damaged', async () => {
    await writeFile(file(), JSON.stringify({ accounts: {}, history: [record, { id: 7 }, null] }));
    expect((await loadState()).history).toEqual([record]);
  });

  it('round-trips history through save and load', async () => {
    await saveState({ accounts: emptyAccountStore, history: [record] });
    expect((await loadState()).history).toEqual([record]);
  });

  it('writes the history key as plain JSON', async () => {
    await saveState({ accounts: emptyAccountStore, history: [record] });
    expect(JSON.parse(await readFile(file(), 'utf8')).history).toEqual([record]);
  });

  it('keeps the file private to the user', async () => {
    await saveState({ accounts: emptyAccountStore, history: [record] });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('writes an empty list when the caller has no history to give', async () => {
    await saveState({ accounts: emptyAccountStore });
    expect(JSON.parse(await readFile(file(), 'utf8')).history).toEqual([]);
  });

  it('saves an empty list as an empty list', async () => {
    await saveState({ accounts: emptyAccountStore, history: [] });
    expect(JSON.parse(await readFile(file(), 'utf8')).history).toEqual([]);
  });
});

describe('User-Agent persistence', () => {
  it('round-trips the setting, including an explicit blank', async () => {
    await saveState({ accounts: emptyAccountStore, userAgent: 'Z 5.6.16' });
    expect((await loadState()).userAgent).toBe('Z 5.6.16');
    await saveState({ accounts: emptyAccountStore, userAgent: '' });
    expect((await loadState()).userAgent).toBe('');
  });

  it('reads as absent from a file written before the setting existed, so the environment can still seed it', async () => {
    await writeFile(file(), JSON.stringify({ accounts: {}, locale: 'en' }));
    expect((await loadState()).userAgent).toBeUndefined();
  });

  it('ignores a stored value that is not a string', async () => {
    await writeFile(file(), JSON.stringify({ accounts: {}, userAgent: 42 }));
    expect((await loadState()).userAgent).toBeUndefined();
  });
});
