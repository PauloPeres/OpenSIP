import { app, BrowserWindow, session } from 'electron';
import type { WebContents } from 'electron';
import { registerIpc } from './ipc';
import { initUpdater } from './updater';
import { createMainWindow, isMediaWebContents, log } from './windows';

const BASE_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'"
];

const CSP = BASE_POLICY.join('; ');

/** The audio worklet is loaded from a Blob, which only the hidden media page may do. */
const MEDIA_CSP = [...BASE_POLICY, "script-src 'self' blob:", "worker-src 'self' blob:"].join('; ');

function policyFor(url: string): string {
  return url.split(/[?#]/)[0]?.endsWith('/media.html') ? MEDIA_CSP : CSP;
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policyFor(details.url)] }
    });
  });
}

function isAppUrl(url: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  return url.startsWith('file://') || (devUrl !== undefined && url.startsWith(devUrl));
}

/** Audio-only microphone capture and notifications, for pages loaded from the app itself. The main window needs this for onboarding, the media window for calls. */
function allowMicrophone(): void {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents: WebContents, permission, callback, details) => {
    const audioOnly = (details as { mediaTypes?: readonly string[] }).mediaTypes?.every((type) => type === 'audio') ?? true;
    const allowed = permission === 'notifications' || (permission === 'media' && audioOnly);
    callback(allowed && isAppUrl(details.requestingUrl));
  });
  defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType;
    const allowed = permission === 'notifications' || (permission === 'media' && mediaType !== 'video');
    return allowed && isAppUrl(details.requestingUrl ?? '');
  });
}

/**
 * The hidden media window keeps the app's window count above zero, so
 * 'window-all-closed' never fires; closing the last visible window quits instead.
 */
function openMainWindow(): void {
  createMainWindow().once('closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function hasMainWindow(): boolean {
  return BrowserWindow.getAllWindows().some((window) => !isMediaWebContents(window.webContents));
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  applyCsp();
  allowMicrophone();
  await registerIpc();
  initUpdater();
  openMainWindow();
  app.on('activate', () => {
    if (!hasMainWindow()) openMainWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

bootstrap().catch((error: unknown) => {
  log('error', `startup failed: ${String(error)}`);
  app.quit();
});
