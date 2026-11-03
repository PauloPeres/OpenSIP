import type { AppSnapshot, OpenSipApi } from '../../../shared/api';

const EMPTY: AppSnapshot = { accounts: [], calls: [], locale: 'en', logs: [], debugLogging: false };

const none = (): Promise<void> => Promise.resolve();
const noop = (): void => undefined;
const subscribeNone = (): (() => void) => noop;

/** Stand-in used when the renderer runs outside Electron (browser preview, tests). */
const OFFLINE_API: OpenSipApi = {
  getSnapshot: () => Promise.resolve(EMPTY),
  saveAccount: () => Promise.resolve({ ok: false, issues: [] }),
  deleteAccount: none,
  setAccountEnabled: none,
  answerCall: none,
  rejectCall: none,
  hangupCall: none,
  holdCall: none,
  resumeCall: none,
  dial: () => Promise.resolve({ ok: false, errorKey: 'calls.error.failed' }),
  sendDtmf: none,
  setMuted: none,
  getLocale: () => Promise.resolve('en'),
  setLocale: (locale) => Promise.resolve(locale),
  setDebugLogging: (enabled) => Promise.resolve(enabled),
  clearLogs: none,
  copyText: () => Promise.resolve(false),
  openSystemSettings: none,
  micPermission: () => Promise.resolve('unknown'),
  onSnapshot: subscribeNone,
  onUpdateStatus: subscribeNone
};

export function getApi(): OpenSipApi {
  return 'opensip' in window ? window.opensip : OFFLINE_API;
}

/** Older main processes may not send every field yet; fill the gaps so the UI never crashes. */
export function normalizeSnapshot(raw: AppSnapshot): AppSnapshot {
  return { ...raw, logs: raw.logs ?? [], debugLogging: raw.debugLogging ?? false };
}

export const EMPTY_SNAPSHOT = EMPTY;
