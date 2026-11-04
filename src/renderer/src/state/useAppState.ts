import { useEffect, useMemo, useState } from 'react';
import type { AccountId } from '@core/sip';
import type {
  AccountDraft,
  AppSnapshot,
  DialResult,
  DtmfDigit,
  OpenSipApi,
  SaveAccountResult,
  UpdateStatus
} from '../../../shared/api';
import { EMPTY_SNAPSHOT, getApi, normalizeSnapshot } from './api';

export interface AppActions {
  readonly saveAccount: (draft: AccountDraft) => Promise<SaveAccountResult>;
  readonly deleteAccount: (id: AccountId) => Promise<void>;
  readonly setAccountEnabled: (id: AccountId, enabled: boolean) => Promise<void>;
  readonly answer: (callId: string) => Promise<void>;
  readonly reject: (callId: string) => Promise<void>;
  readonly hangup: (callId: string) => Promise<void>;
  readonly hold: (callId: string) => Promise<void>;
  readonly resume: (callId: string) => Promise<void>;
  readonly dial: (accountId: AccountId, target: string) => Promise<DialResult>;
  readonly dtmf: (callId: string, digit: DtmfDigit) => Promise<void>;
  readonly mute: (callId: string, muted: boolean) => Promise<void>;
  readonly setDebug: (enabled: boolean) => Promise<boolean>;
  readonly setUserAgent: (value: string) => Promise<string>;
  readonly clearLogs: () => Promise<void>;
  readonly clearHistory: () => Promise<void>;
  readonly removeHistoryEntry: (id: string) => Promise<void>;
  readonly openReleasePage: () => Promise<void>;
}

export interface AppState {
  readonly snapshot: AppSnapshot;
  readonly update: UpdateStatus;
  readonly failed: boolean;
  readonly actions: AppActions;
}

function settingsActions(api: OpenSipApi): Pick<AppActions, 'setDebug' | 'setUserAgent'> {
  return { setDebug: (enabled) => api.setDebugLogging(enabled), setUserAgent: (value) => api.setUserAgent(value) };
}

function maintenanceActions(api: OpenSipApi): Pick<AppActions, 'clearLogs' | 'clearHistory' | 'removeHistoryEntry' | 'openReleasePage'> {
  return {
    clearLogs: () => api.clearLogs(),
    clearHistory: () => api.clearHistory(),
    removeHistoryEntry: (id) => api.removeHistoryEntry(id),
    openReleasePage: () => api.openReleasePage()
  };
}

function buildActions(): AppActions {
  const api = getApi();
  return {
    saveAccount: (draft) => api.saveAccount(draft),
    deleteAccount: (id) => api.deleteAccount(id),
    setAccountEnabled: (id, enabled) => api.setAccountEnabled(id, enabled),
    answer: (id) => api.answerCall(id),
    reject: (id) => api.rejectCall(id),
    hangup: (id) => api.hangupCall(id),
    hold: (id) => api.holdCall(id),
    resume: (id) => api.resumeCall(id),
    dial: (accountId, target) => api.dial(accountId, target),
    dtmf: (id, digit) => api.sendDtmf(id, digit),
    mute: (id, muted) => api.setMuted(id, muted),
    ...settingsActions(api),
    ...maintenanceActions(api)
  };
}

function subscribeAll(
  api: OpenSipApi,
  onSnapshot: (snapshot: AppSnapshot) => void,
  onUpdate: (status: UpdateStatus) => void
): () => void {
  const offSnapshot = api.onSnapshot((snapshot) => onSnapshot(normalizeSnapshot(snapshot)));
  const offUpdate = api.onUpdateStatus(onUpdate);
  return (): void => {
    offSnapshot();
    offUpdate();
  };
}

export function useAppState(): AppState {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [update, setUpdate] = useState<UpdateStatus>({ kind: 'idle' });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const api = getApi();
    api
      .getUpdateStatus()
      .then((status) => setUpdate((current) => (current.kind === 'idle' ? status : current)))
      .catch(() => undefined);
    api
      .getSnapshot()
      .then((raw) => setSnapshot(normalizeSnapshot(raw)))
      .catch(() => setFailed(true));
    return subscribeAll(api, setSnapshot, setUpdate);
  }, []);
  const actions = useMemo(buildActions, []);
  return { snapshot, update, failed, actions };
}
