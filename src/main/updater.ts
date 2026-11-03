import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import { IPC } from '../shared/api';
import type { UpdateStatus } from '../shared/api';
import { log } from './windows';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function broadcast(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.updateStatus, status);
  }
}

function checkNow(): void {
  autoUpdater.checkForUpdates().catch((error: unknown) => {
    log('warn', `update check failed: ${String(error)}`);
    broadcast({ kind: 'error' });
  });
}

function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    broadcast({ kind: 'available', version: info.version })
  );
  autoUpdater.on('update-not-available', () => broadcast({ kind: 'upToDate' }));
  autoUpdater.on('error', () => broadcast({ kind: 'error' }));
}

export function initUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  wireEvents();
  if (!app.isPackaged) return;
  checkNow();
  setInterval(checkNow, CHECK_INTERVAL_MS);
}
