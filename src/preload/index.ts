import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/api';
import type { OpenSipApi, Unsubscribe } from '../shared/api';
import { MEDIA_WINDOW_ARGUMENT } from '../shared/media';
import { exposeMediaApi } from './media';

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
  setAccountEnabled: (id, enabled) => ipcRenderer.invoke(IPC.setAccountEnabled, id, enabled),
  answerCall: callAction(IPC.answerCall),
  rejectCall: callAction(IPC.rejectCall),
  hangupCall: callAction(IPC.hangupCall),
  holdCall: callAction(IPC.holdCall),
  resumeCall: callAction(IPC.resumeCall),
  dial: (accountId, target) => ipcRenderer.invoke(IPC.dial, accountId, target),
  sendDtmf: (callId, digit) => ipcRenderer.invoke(IPC.sendDtmf, callId, digit),
  setMuted: (callId, muted) => ipcRenderer.invoke(IPC.setMuted, callId, muted),
  getLocale: () => ipcRenderer.invoke(IPC.getLocale),
  setLocale: (locale) => ipcRenderer.invoke(IPC.setLocale, locale),
  setDebugLogging: (enabled) => ipcRenderer.invoke(IPC.setDebugLogging, enabled),
  setUserAgent: (value) => ipcRenderer.invoke(IPC.setUserAgent, value),
  clearLogs: () => ipcRenderer.invoke(IPC.clearLogs),
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory),
  removeHistoryEntry: (id) => ipcRenderer.invoke(IPC.removeHistoryEntry, id),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  openSystemSettings: () => ipcRenderer.invoke(IPC.openSystemSettings),
  micPermission: () => ipcRenderer.invoke(IPC.micPermission),
  onSnapshot: (cb) => subscribe(IPC.subscribe, cb),
  onUpdateStatus: (cb) => subscribe(IPC.updateStatus, cb)
};

/*
 * electron-vite builds one preload entry (index), so the hidden media window
 * shares this file and is told apart by a launch argument. It gets the media
 * bridge and nothing else.
 */
if (process.argv.includes(MEDIA_WINDOW_ARGUMENT)) exposeMediaApi();
else contextBridge.exposeInMainWorld('opensip', api);
