import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createDiagnosticsLog } from '@core/diagnostics';
import { isSupportedLocale, resolveLocale } from '@core/i18n';
import type { Locale } from '@core/i18n';
import { parseEnvAccounts } from '@core/config/env-accounts';
import {
  accountKey,
  addAccount,
  createAccount,
  emptyAccountStore,
  enabledAccounts,
  getAccount,
  initialRegistration,
  listAccounts,
  removeAccount,
  updateAccount,
  validateAccountInput
} from '@core/sip';
import type { AccountId, AccountStoreState, SipAccount, SipAccountInput, ValidationIssue } from '@core/sip';
import { IPC, isDtmfDigit } from '../shared/api';
import type { AccountDraft, AccountView, AppSnapshot, DialResult, SaveAccountResult } from '../shared/api';
import { loadState, saveState } from './account-storage';
import { createMediaBridge } from './media';
import { SipEngine } from './sip/engine';
import { electronMediaDeps, isMediaWebContents, log } from './windows';

/** At most one snapshot per ~two animation frames, however many log lines or call events arrive. */
const BROADCAST_INTERVAL_MS = 33;
/** Live packet counters change continuously; the UI only needs them about once a second. */
const STATS_INTERVAL_MS = 1_000;

const DUPLICATE_ISSUE: ValidationIssue = {
  field: 'username',
  messageKey: 'accounts.validation.duplicate'
};

class Controller {
  /** The one diagnostics log of the app; the engine writes to it, snapshots read from it. */
  readonly diagnostics = createDiagnosticsLog();
  readonly media = createMediaBridge(electronMediaDeps());
  readonly engine = new SipEngine({ diagnostics: this.diagnostics, media: this.media });
  store: AccountStoreState = emptyAccountStore;
  locale: Locale = resolveLocale(app.getLocale());
  private cooling = false;
  private dirty = false;

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
    return {
      accounts,
      calls: this.engine.getCallViews(),
      locale: this.locale,
      logs: this.diagnostics.entries(),
      debugLogging: this.diagnostics.debug
    };
  }

  /**
   * Leading-edge throttle: the first change goes out immediately, the rest of
   * a burst collapses into one more snapshot when the cooldown ends.
   */
  broadcast(): void {
    if (this.cooling) {
      this.dirty = true;
      return;
    }
    this.send(this.snapshot());
    this.cooling = true;
    setTimeout(() => this.cooldown(), BROADCAST_INTERVAL_MS);
  }

  private cooldown(): void {
    this.cooling = false;
    if (!this.dirty) return;
    this.dirty = false;
    this.broadcast();
  }

  private send(snapshot: AppSnapshot): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!isMediaWebContents(window.webContents)) window.webContents.send(IPC.subscribe, snapshot);
    }
  }

  /** Keeps the packet counters on screen moving while a call has media. */
  startStatsTicker(): void {
    const ticker = setInterval(() => {
      if (this.engine.getCallViews().some((view) => view.media !== undefined)) this.broadcast();
    }, STATS_INTERVAL_MS);
    ticker.unref();
  }

  async persist(): Promise<void> {
    await saveState({ accounts: this.store, locale: this.locale, debugLogging: this.diagnostics.debug });
  }

  async setDebugLogging(enabled: boolean): Promise<boolean> {
    this.diagnostics.setDebug(enabled);
    await this.persist();
    this.broadcast();
    return this.diagnostics.debug;
  }

  clearLogs(): void {
    this.diagnostics.clear();
    this.broadcast();
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
    await this.upsert(createAccount(this.keepingSwitch(input, id), id ?? randomUUID()));
    return { ok: true };
  }

  /** Editing an account must not silently turn a disabled one back on. */
  private keepingSwitch(input: SipAccountInput, id: AccountId | undefined): SipAccountInput {
    if (input.enabled !== undefined || id === undefined || !Object.hasOwn(this.store, id)) return input;
    return { ...input, enabled: getAccount(this.store, id).enabled };
  }

  async upsert(account: SipAccount): Promise<void> {
    await this.engine.stopAccount(account.id);
    this.store = addAccount(removeIfPresent(this.store, account.id), account);
    await this.persist();
    if (account.enabled) await this.engine.startAccount(account);
    this.broadcast();
  }

  /** True while any call of the account is ringing, connecting, active or held. */
  private hasLiveCall(id: AccountId): boolean {
    return this.engine.getCallViews().some((view) => view.call.accountId === id && view.call.state !== 'ended');
  }

  /**
   * Off refuses while the account has a live call (the user hangs up first) rather
   * than tearing the call and its RTP session down underneath them.
   */
  async setEnabled(id: AccountId, enabled: boolean): Promise<void> {
    const current = getAccount(this.store, id);
    if (current.enabled === enabled) return;
    if (!enabled && this.hasLiveCall(id)) throw new Error('accounts.disableBusy');
    this.store = updateAccount(this.store, id, { enabled });
    await this.persist();
    this.diagnostics.append({
      level: 'info',
      messageKey: enabled ? 'logs.event.enabled' : 'logs.event.disabled',
      accountId: id,
      params: { account: current.uri }
    });
    if (enabled) await this.engine.startAccount(getAccount(this.store, id));
    else await this.engine.stopAccount(id);
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

const INVALID_TARGET: DialResult = { ok: false, errorKey: 'calls.error.invalidTarget' };

/** The renderer is not trusted to send well-typed arguments, least of all bytes destined for an RTP stream. */
function registerMediaHandlers(controller: Controller): void {
  const { engine } = controller;
  ipcMain.handle(IPC.dial, (_event, accountId: unknown, target: unknown): Promise<DialResult> | DialResult =>
    typeof accountId === 'string' && typeof target === 'string' ? engine.dial(accountId, target) : INVALID_TARGET
  );
  ipcMain.handle(IPC.sendDtmf, (_event, callId: unknown, digit: unknown): void => {
    if (typeof callId === 'string' && isDtmfDigit(digit)) engine.sendDtmf(callId, digit);
  });
  ipcMain.handle(IPC.setMuted, (_event, callId: unknown, muted: unknown): void => {
    if (typeof callId === 'string' && typeof muted === 'boolean') engine.setMuted(callId, muted);
  });
}

function registerAccountSwitchHandler(controller: Controller): void {
  ipcMain.handle(IPC.setAccountEnabled, (_event, id: unknown, enabled: unknown): Promise<void> => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return Promise.reject(new Error('invalid-argument'));
    if (!Object.hasOwn(controller.store, id)) return Promise.reject(new Error('account-not-found'));
    return controller.setEnabled(id, enabled);
  });
}

/** A fixed destination: nothing from the renderer reaches openExternal. Other platforms have no such deep link, so they do nothing. */
const MAC_PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

function registerSystemSettingsHandler(): void {
  ipcMain.handle(IPC.openSystemSettings, async (): Promise<void> => {
    if (process.platform === 'darwin') await shell.openExternal(MAC_PRIVACY_PANE);
  });
}

function registerLogHandlers(controller: Controller): void {
  ipcMain.handle(IPC.setDebugLogging, (_event, enabled: unknown) => controller.setDebugLogging(enabled === true));
  ipcMain.handle(IPC.clearLogs, () => controller.clearLogs());
}

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
  registerAccountSwitchHandler(controller);
  registerCallHandlers(controller);
  registerMediaHandlers(controller);
  registerLogHandlers(controller);
  registerSystemSettingsHandler();
}

export async function registerIpc(): Promise<void> {
  const controller = new Controller();
  const persisted = await loadState();
  controller.store = persisted.accounts;
  if (persisted.locale !== undefined) controller.locale = persisted.locale;
  controller.diagnostics.setDebug(persisted.debugLogging === true);
  controller.seed();
  await controller.persist();
  controller.engine.onChange(() => controller.broadcast());
  registerHandlers(controller);
  controller.startStatsTicker();
  app.on('before-quit', () => {
    controller.engine
      .stop()
      .catch((error: unknown) => log('warn', `engine stop: ${String(error)}`))
      .finally(() => controller.media.dispose());
  });
  await controller.engine.start(enabledAccounts(controller.store));
}
