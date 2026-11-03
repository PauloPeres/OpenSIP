import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountId } from '@core/sip';
import { SETUP_IN_PROGRESS_KEY, isOutboundInSetup } from '../../../shared/api';
import type { AccountView, CallView, DialResult } from '../../../shared/api';

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
  readonly calls: readonly CallView[];
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
  readonly waiting: boolean;
  readonly errorKey: string | null;
  readonly busy: boolean;
  readonly submit: (event: FormEvent) => void;
}

interface SubmitModel {
  readonly errorKey: string | null;
  readonly busy: boolean;
  readonly submit: (event: FormEvent) => void;
}

/** Every refused attempt names its reason, so pressing Call never ends in silence. */
function refusal(accountId: AccountId | null, target: string, calls: readonly CallView[]): string | null {
  if (accountId === null) return 'calls.error.noAccount'; // i18n-exempt: translation key
  if (target.trim() === '') return 'calls.error.noTarget'; // i18n-exempt: translation key
  return calls.some((view) => isOutboundInSetup(view.call, accountId)) ? SETUP_IN_PROGRESS_KEY : null;
}

interface Request {
  readonly errorKey: string | null;
  readonly setErrorKey: (key: string | null) => void;
  readonly busy: boolean;
  readonly place: (id: AccountId, target: string) => void;
}

function useDialRequest(args: DialerArgs, clear: () => void): Request {
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = (result: DialResult): void => {
    setErrorKey(result.ok ? null : result.errorKey);
    if (!result.ok) return;
    clear();
    args.onDialed(result.callId);
  };
  const place = (id: AccountId, target: string): void => {
    setBusy(true);
    const fail = (): void => setErrorKey('calls.error.failed');
    args.dial(id, target.trim()).then(finish).catch(fail).finally(() => setBusy(false));
  };
  return { errorKey, setErrorKey, busy, place };
}

function useDialSubmit(args: DialerArgs, accountId: AccountId | null, target: string, clear: () => void): SubmitModel {
  const { errorKey, setErrorKey, busy, place } = useDialRequest(args, clear);
  useEffect(() => setErrorKey(null), [target, accountId, setErrorKey]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const refused = refusal(accountId, target, args.calls);
    setErrorKey(refused);
    if (!busy && refused === null && accountId !== null) place(accountId, target);
  };
  return { errorKey, busy, submit };
}

export function useDialer(args: DialerArgs): DialerModel {
  const [target, setTarget] = useState('');
  const [chosen, setAccountId] = useState<AccountId | null>(null);
  const append = useCallback((digit: string): void => setTarget((c) => c + digit), []);
  const backspace = useCallback((): void => setTarget((c) => c.slice(0, -1)), []);
  usePhysicalKeys(append, backspace);
  const registered = args.accounts.filter((a) => a.account.enabled && a.registration.state === 'registered');
  const accountId = registered.find((a) => a.account.id === chosen)?.account.id ?? registered[0]?.account.id ?? null;
  const sub = useDialSubmit(args, accountId, target, () => setTarget(''));
  const waiting = args.accounts.some((a) => a.registration.state === 'registering');
  return { target, setTarget, append, backspace, registered, accountId, setAccountId, waiting, ...sub };
}
