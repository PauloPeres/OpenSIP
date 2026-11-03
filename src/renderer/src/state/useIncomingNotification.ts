import { useEffect, useRef } from 'react';
import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { isIncomingRing } from './useLines';
import type { Line } from './useLines';

function canNotify(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' && !document.hasFocus();
}

function raise(title: string, body: string): Notification | null {
  try {
    const note = new Notification(title, { body });
    note.onclick = (): void => {
      window.focus();
      note.close();
    };
    return note;
  } catch {
    return null;
  }
}

/** One desktop notification per incoming call, only while the window is in the background. */
export function useIncomingNotification(lines: readonly Line[], accounts: readonly AccountView[]): void {
  const { t } = useTranslation();
  const shown = useRef(new Map<string, Notification | null>());
  useEffect(() => {
    const ringing = lines.filter(isIncomingRing);
    const ids = new Set(ringing.map((l) => l.view.call.id));
    shown.current.forEach((note, id) => {
      if (ids.has(id)) return;
      note?.close();
      shown.current.delete(id);
    });
    for (const line of ringing) {
      const { id, remoteIdentity, accountId } = line.view.call;
      if (shown.current.has(id) || !canNotify()) continue;
      const account = accounts.find((a) => a.account.id === accountId)?.account.displayName ?? '';
      shown.current.set(id, raise(t('notification.incoming.title'), t('notification.incoming.body', { caller: remoteIdentity, account })));
    }
  }, [lines, accounts, t]);
  useEffect(() => (): void => shown.current.forEach((note) => note?.close()), []);
}
