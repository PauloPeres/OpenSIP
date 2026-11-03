import { useEffect, useRef, useState } from 'react';
import { callStateKey } from '@core/sip';
import type { CallState } from '@core/sip';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { Line } from './useLines';

/** Text for an aria-live region: the most recent call state change, as one sentence. */
export function useAnnouncement(lines: readonly Line[]): string {
  const { t } = useTranslation();
  const seen = useRef(new Map<string, CallState>());
  const [message, setMessage] = useState('');
  useEffect(() => {
    const changed = lines.find((l) => seen.current.get(l.view.call.id) !== l.view.call.state);
    seen.current = new Map(lines.map((l) => [l.view.call.id, l.view.call.state]));
    if (changed === undefined) return;
    const { call } = changed.view;
    setMessage(`${t('calls.line', { number: changed.slot })}, ${call.remoteIdentity}: ${t(callStateKey(call.state))}`);
  }, [lines, t]);
  return message;
}
