import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import { IPC } from '../shared/api';
import type { UpdateStatus } from '../shared/api';
import { decideUpdateMode, parseSignature } from './update-policy';
import type { SignatureKind, UpdateMode } from './update-policy';
import { log } from './windows';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A fixed destination: nothing from the renderer reaches openExternal. */
const RELEASES_URL = 'https://github.com/PauloPeres/OpenSIP/releases/latest';

let mode: UpdateMode = 'auto';
let lastStatus: UpdateStatus = { kind: 'idle' };

export function currentUpdateStatus(): UpdateStatus {
  return lastStatus;
}

export async function openReleasePage(): Promise<void> {
  await shell.openExternal(RELEASES_URL);
}

function broadcast(status: UpdateStatus): void {
  lastStatus = status;
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

function onAvailable(info: UpdateInfo): void {
  broadcast({ kind: mode === 'auto' ? 'available' : 'manual', version: info.version });
}

function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', onAvailable);
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => broadcast({ kind: 'downloaded', version: info.version }));
  autoUpdater.on('update-not-available', () => broadcast({ kind: 'upToDate' }));
  autoUpdater.on('error', () => broadcast({ kind: 'error' }));
}

/** `…/Name.app/Contents/MacOS/Name` is three levels below the bundle that carries the signature. */
function readSignature(): Promise<SignatureKind> {
  const bundle = resolve(process.execPath, '..', '..', '..');
  return new Promise((done) => {
    execFile('codesign', ['-dv', '--verbose=4', bundle], (_error, _stdout, stderr) => done(parseSignature(stderr)));
  });
}

async function startChecks(): Promise<void> {
  const signature = process.platform === 'darwin' ? await readSignature() : 'unknown';
  mode = decideUpdateMode(process.platform, signature);
  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = mode === 'auto';
  log('info', `update mode: ${mode} (signature ${signature})`);
  checkNow();
  setInterval(checkNow, CHECK_INTERVAL_MS);
}

export function initUpdater(): void {
  wireEvents();
  if (!app.isPackaged) return;
  void startChecks();
}
