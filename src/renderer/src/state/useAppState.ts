import { useEffect, useMemo, useState } from 'react';
import type { AccountId } from '@core/sip';
import type { AccountDraft, AppSnapshot, SaveAccountResult, UpdateStatus } from '../../../shared/api';

export interface AppActions {
  readonly saveAccount: (draft: AccountDraft) => Promise<SaveAccountResult>;
  readonly deleteAccount: (id: AccountId) => Promise<void>;
  readonly answer: (callId: string) => Promise<void>;
  readonly reject: (callId: string) => Promise<void>;
  readonly hangup: (callId: string) => Promise<void>;
  readonly hold: (callId: string) => Promise<void>;
  readonly resume: (callId: string) => Promise<void>;
}

export interface AppState {
  readonly snapshot: AppSnapshot;
  readonly update: UpdateStatus;
  readonly failed: boolean;
  readonly actions: AppActions;
}

const EMPTY_SNAPSHOT: AppSnapshot = { accounts: [], calls: [], locale: 'en' };

function buildActions(): AppActions {
  const api = window.opensip;
  return {
    saveAccount: (draft) => api.saveAccount(draft),
    deleteAccount: (id) => api.deleteAccount(id),
    answer: (id) => api.answerCall(id),
    reject: (id) => api.rejectCall(id),
    hangup: (id) => api.hangupCall(id),
    hold: (id) => api.holdCall(id),
    resume: (id) => api.resumeCall(id)
  };
}

function subscribeAll(
  onSnapshot: (snapshot: AppSnapshot) => void,
  onUpdate: (status: UpdateStatus) => void
): () => void {
  const offSnapshot = window.opensip.onSnapshot(onSnapshot);
  const offUpdate = window.opensip.onUpdateStatus(onUpdate);
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
    window.opensip.getSnapshot().then(setSnapshot).catch(() => setFailed(true));
    return subscribeAll(setSnapshot, setUpdate);
  }, []);
  const actions = useMemo(buildActions, []);
  return { snapshot, update, failed, actions };
}
