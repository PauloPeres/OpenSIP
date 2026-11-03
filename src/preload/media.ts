import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { MEDIA_IPC, toPcmFrame } from '../shared/media';
import type { MediaPreloadApi, Unsubscribe } from '../shared/media';

/*
 * The hidden media window's own bridge. It exposes frames and call ids only:
 * no account data, no SIP, and none of the main window's `opensip` API.
 */

function listen(channel: string, handler: (...args: unknown[]) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const onCall =
  (channel: string) =>
  (listener: (callId: string) => void): Unsubscribe =>
    listen(channel, (callId) => {
      if (typeof callId === 'string') listener(callId);
    });

const api: MediaPreloadApi = {
  onStart: onCall(MEDIA_IPC.start),
  onStop: onCall(MEDIA_IPC.stop),
  onPlayback: (listener) =>
    listen(MEDIA_IPC.playback, (callId, data) => {
      const samples = toPcmFrame(data);
      if (typeof callId === 'string' && samples !== undefined) listener(callId, samples);
    }),
  sendCapture: (callId, samples) => ipcRenderer.send(MEDIA_IPC.capture, callId, samples),
  reportError: (callId, message) => ipcRenderer.send(MEDIA_IPC.error, callId, message)
};

export function exposeMediaApi(): void {
  contextBridge.exposeInMainWorld('opensipMedia', api);
}
