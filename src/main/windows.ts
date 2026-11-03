import { join } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import { MEDIA_WINDOW_ARGUMENT } from '../shared/media';
import type { MediaBridgeDeps, MediaWindowHandle } from './media/media-window';

const WINDOW_WIDTH = 1000;
const WINDOW_HEIGHT = 700;

/** Minimal stderr logger (eslint forbids `console`). */
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  process.stderr.write(`[opensip:${level}] ${message}\n`);
}

function loadRenderer(window: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const target = devUrl
    ? window.loadURL(devUrl)
    : window.loadFile(join(__dirname, '../renderer/index.html'));
  target.catch((error: unknown) => log('error', `renderer load failed: ${String(error)}`));
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  window.once('ready-to-show', () => window.show());
  loadRenderer(window);
  return window;
}

/* ------------------------------------------------------------ media window */

const mediaContentsIds = new Set<number>();

/** True for the hidden audio window's web contents, and nothing else. */
export function isMediaWebContents(contents: WebContents | null): boolean {
  return contents !== null && mediaContentsIds.has(contents.id);
}

function loadMediaPage(window: BrowserWindow): Promise<void> {
  const { webContents } = window;
  return new Promise<void>((resolve, reject) => {
    webContents.once('did-finish-load', () => resolve());
    webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code} ${description}`)));
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    const load = devUrl
      ? window.loadURL(`${devUrl}/media.html`)
      : window.loadFile(join(__dirname, '../renderer/media.html'));
    load.catch(reject);
  });
}

function newMediaWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      additionalArguments: [MEDIA_WINDOW_ARGUMENT],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The page is never shown and never clicked: audio must still run at full rate.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
}

function mediaHandle(window: BrowserWindow): MediaWindowHandle {
  const id = window.webContents.id;
  mediaContentsIds.add(id);
  window.once('closed', () => mediaContentsIds.delete(id));
  return {
    send: (channel, ...args) => window.webContents.send(channel, ...args),
    isDestroyed: () => window.isDestroyed(),
    owns: (sender) => (sender as { id?: number } | null)?.id === id,
    ready: loadMediaPage(window),
    onClosed: (listener): void => {
      window.once('closed', listener);
      window.webContents.once('render-process-gone', listener);
    },
    destroy: (): void => {
      if (!window.isDestroyed()) window.destroy();
    }
  };
}

export function electronMediaDeps(): MediaBridgeDeps {
  return {
    createWindow: () => mediaHandle(newMediaWindow()),
    listen: (channel, handler) => {
      const listener = (event: IpcMainEvent, ...args: unknown[]): void => handler(event.sender, ...args);
      ipcMain.on(channel, listener);
      return () => void ipcMain.removeListener(channel, listener);
    },
    log: (message) => log('warn', message)
  };
}
