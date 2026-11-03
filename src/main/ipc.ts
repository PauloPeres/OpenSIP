import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import { isSupportedLocale, resolveLocale } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { parseEnvAccounts } from '@core/config/env-accounts';
import {
  accountKey,
  addAccount,
  createAccount,
  emptyAccountStore,
  initialRegistration,
  listAccounts,
  removeAccount,
  validateAccountInput
} from '@core/sip';
import type { AccountId, AccountStoreState, SipAccount, SipAccountInput, ValidationIssue } from '@core/sip';
import { IPC } from '../shared/api';
import type { AccountDraft, AccountView, AppSnapshot, SaveAccountResult } from '../shared/api';
import { loadState, saveState } from './account-storage';
import { SipEngine } from './sip/engine';
import { log } from './windows';

const DUPLICATE_ISSUE: ValidationIssue = {
  field: 'username',
  messageKey: 'accounts.validation.duplicate'
};

class Controller {
  readonly engine = new SipEngine();
  store: AccountStoreState = emptyAccountStore;
  locale: Locale = resolveLocale(app.getLocale());

  snapshot(): AppSnapshot {
    const registrations = this.engine.getRegistrations();
    const transports = this.engine.getTransports();
    const accounts = listAccounts(this.store).map((account): AccountView => {
      const transport = transports[account.id]?.transport;
      return {
        account,
        registration: registrations[account.id] ?? initialRegistration,
        ...(transport === undefined ? {} : { transport })
      };
    });
    return { accounts, calls: this.engine.getCalls(), locale: this.locale };
  }

  broadcast(): void {
    const snapshot = this.snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.subscribe, snapshot);
    }
  }

  async persist(): Promise<void> {
    await saveState({ accounts: this.store, locale: this.locale });
  }

  isDuplicate(input: SipAccountInput, ownId: AccountId | undefined): boolean {
    const key = accountKey(input);
    return listAccounts(this.store).some((a) => a.id !== ownId && accountKey(a) === key);
  }

  async save(draft: AccountDraft): Promise<SaveAccountResult> {
    const { id, ...input } = draft;
    const issues = [...validateAccountInput(input)];
    if (issues.length === 0 && this.isDuplicate(input, id)) issues.push(DUPLICATE_ISSUE);
    if (issues.length > 0) return { ok: false, issues };
    await this.upsert(createAccount(input, id ?? randomUUID()));
    return { ok: true };
  }

  async upsert(account: SipAccount): Promise<void> {
    await this.engine.stopAccount(account.id);
    this.store = addAccount(removeIfPresent(this.store, account.id), account);
    await this.persist();
    await this.engine.startAccount(account);
    this.broadcast();
  }

  async remove(id: AccountId): Promise<void> {
    await this.engine.stopAccount(id);
    this.store = removeIfPresent(this.store, id);
    await this.persist();
    this.broadcast();
  }

  async setLocale(locale: Locale): Promise<Locale> {
    if (isSupportedLocale(locale)) this.locale = locale;
    await this.persist();
    this.broadcast();
    return this.locale;
  }

  seed(): void {
    if (app.isPackaged || listAccounts(this.store).length > 0) return;
    for (const draft of parseEnvAccounts(process.env)) this.seedOne(draft.input);
  }

  private seedOne(input: SipAccountInput): void {
    if (this.isDuplicate(input, undefined)) return;
    try {
      this.store = addAccount(this.store, createAccount(input, randomUUID()));
    } catch (error) {
      log('warn', `skipping invalid seed account: ${String(error)}`);
    }
  }
}

function removeIfPresent(store: AccountStoreState, id: AccountId): AccountStoreState {
  return Object.hasOwn(store, id) ? removeAccount(store, id) : store;
}

type CallAction = (callId: string) => Promise<void>;

function registerCallHandlers(controller: Controller): void {
  const { engine } = controller;
  const actions: readonly (readonly [string, CallAction])[] = [
    [IPC.answerCall, engine.answer.bind(engine)],
    [IPC.rejectCall, engine.reject.bind(engine)],
    [IPC.hangupCall, engine.hangup.bind(engine)],
    [IPC.holdCall, engine.hold.bind(engine)],
    [IPC.resumeCall, engine.resume.bind(engine)]
  ];
  for (const [channel, action] of actions) {
    ipcMain.handle(channel, (_event, callId: string) => action(callId));
  }
}

function registerHandlers(controller: Controller): void {
  ipcMain.handle(IPC.listSnapshot, () => controller.snapshot());
  ipcMain.handle(IPC.saveAccount, (_event, draft: AccountDraft) => controller.save(draft));
  ipcMain.handle(IPC.deleteAccount, (_event, id: AccountId) => controller.remove(id));
  ipcMain.handle(IPC.getLocale, () => controller.locale);
  ipcMain.handle(IPC.setLocale, (_event, locale: Locale) => controller.setLocale(locale));
  registerCallHandlers(controller);
}

export async function registerIpc(): Promise<void> {
  const controller = new Controller();
  const persisted = await loadState();
  controller.store = persisted.accounts;
  if (persisted.locale !== undefined) controller.locale = persisted.locale;
  controller.seed();
  await controller.persist();
  controller.engine.onChange(() => controller.broadcast());
  registerHandlers(controller);
  app.on('before-quit', () => {
    controller.engine.stop().catch((error: unknown) => log('warn', `engine stop: ${String(error)}`));
  });
  await controller.engine.start(listAccounts(controller.store));
}
