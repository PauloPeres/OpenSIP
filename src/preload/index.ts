import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/api';
import type { OpenSipApi, Unsubscribe } from '../shared/api';

function subscribe<T>(channel: string, cb: (value: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const callAction =
  (channel: string) =>
  (callId: string): Promise<void> =>
    ipcRenderer.invoke(channel, callId);

const api: OpenSipApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.listSnapshot),
  saveAccount: (input) => ipcRenderer.invoke(IPC.saveAccount, input),
  deleteAccount: (id) => ipcRenderer.invoke(IPC.deleteAccount, id),
  answerCall: callAction(IPC.answerCall),
  rejectCall: callAction(IPC.rejectCall),
  hangupCall: callAction(IPC.hangupCall),
  holdCall: callAction(IPC.holdCall),
  resumeCall: callAction(IPC.resumeCall),
  getLocale: () => ipcRenderer.invoke(IPC.getLocale),
  setLocale: (locale) => ipcRenderer.invoke(IPC.setLocale, locale),
  onSnapshot: (cb) => subscribe(IPC.subscribe, cb),
  onUpdateStatus: (cb) => subscribe(IPC.updateStatus, cb)
};

contextBridge.exposeInMainWorld('opensip', api);
