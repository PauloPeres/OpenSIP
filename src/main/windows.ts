import { join } from 'node:path';
import { BrowserWindow } from 'electron';

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
