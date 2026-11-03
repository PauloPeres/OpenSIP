import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountId } from '@core/sip';
import type { AccountView, DialResult } from '../../../shared/api';

const DIAL_KEY = /^[0-9*#]$/;

function isEditable(target: EventTarget | null): boolean {
  // i18n-exempt: CSS selector
  return target instanceof HTMLElement && target.matches('input, textarea, select, [contenteditable=true]');
}

function usePhysicalKeys(append: (digit: string) => void, backspace: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      // i18n-exempt: KeyboardEvent.key name
      if (event.key === 'Backspace') backspace();
      else if (DIAL_KEY.test(event.key)) append(event.key);
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [append, backspace]);
}

export interface DialerArgs {
  readonly accounts: readonly AccountView[];
  readonly dial: (accountId: AccountId, target: string) => Promise<DialResult>;
  readonly onDialed: (callId: string) => void;
}

export interface DialerModel {
  readonly target: string;
  readonly setTarget: (value: string) => void;
  readonly append: (digit: string) => void;
  readonly backspace: () => void;
  readonly registered: readonly AccountView[];
  readonly accountId: AccountId | null;
  readonly setAccountId: (id: AccountId) => void;
  readonly errorKey: string | null;
  readonly busy: boolean;
  readonly submit: (event: FormEvent) => void;
}

interface SubmitModel {
  readonly errorKey: string | null;
  readonly busy: boolean;
  readonly submit: (event: FormEvent) => void;
}

function useDialSubmit(args: DialerArgs, accountId: AccountId | null, target: string, clear: () => void): SubmitModel {
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = (result: DialResult): void => {
    setErrorKey(result.ok ? null : result.errorKey);
    if (result.ok) clear();
    if (result.ok) args.onDialed(result.callId);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (target.trim() === '' || accountId === null || busy) return;
    setBusy(true);
    args
      .dial(accountId, target.trim())
      .then(finish)
      .catch(() => setErrorKey('calls.error.failed'))
      .finally(() => setBusy(false));
  };
  return { errorKey, busy, submit };
}

export function useDialer(args: DialerArgs): DialerModel {
  const [target, setTarget] = useState('');
  const [chosen, setAccountId] = useState<AccountId | null>(null);
  const append = useCallback((digit: string): void => setTarget((c) => c + digit), []);
  const backspace = useCallback((): void => setTarget((c) => c.slice(0, -1)), []);
  usePhysicalKeys(append, backspace);
  const registered = args.accounts.filter((a) => a.registration.state === 'registered');
  const accountId = registered.find((a) => a.account.id === chosen)?.account.id ?? registered[0]?.account.id ?? null;
  const sub = useDialSubmit(args, accountId, target, () => setTarget(''));
  return { target, setTarget, append, backspace, registered, accountId, setAccountId, ...sub };
}
