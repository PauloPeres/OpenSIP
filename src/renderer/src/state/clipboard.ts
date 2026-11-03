import type { OpenSipApi } from '../../../shared/api';

/**
 * Copies through Electron's clipboard in the main process first: the web Clipboard API is subject to the
 * session's permission handler and to document focus, and rejects without any visible sign.
 * The web API stays as a second try for runs outside Electron. Resolves false when both fail.
 */
export async function copyToClipboard(api: Pick<OpenSipApi, 'copyText'>, text: string): Promise<boolean> {
  try {
    if (await api.copyText(text)) return true;
  } catch {
    // The IPC path is unavailable; try the web API below.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
