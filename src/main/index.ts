import { app, BrowserWindow, session } from 'electron';
import { registerIpc } from './ipc';
import { initUpdater } from './updater';
import { createMainWindow, log } from './windows';

const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'"
].join('; ');

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] }
    });
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  applyCsp();
  await registerIpc();
  initUpdater();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

bootstrap().catch((error: unknown) => {
  log('error', `startup failed: ${String(error)}`);
  app.quit();
});
