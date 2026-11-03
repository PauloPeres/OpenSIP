import { useState } from 'react';
import { callStateKey } from '@core/sip';
import type { AccountView, CallView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { isPending, isWaiting, progressKey } from '../state/callProgress';
import { formatDuration } from '../state/format';
import type { AppActions } from '../state/useAppState';
import { isIncomingRing } from '../state/useLines';
import type { Line } from '../state/useLines';
import { Avatar } from './ui/Badge';
import { Breakable } from './ui/Breakable';
import { Button } from './ui/Button';
import { cx } from './ui/cx';
import { Keypad } from './ui/Keypad';

export interface LineEnv {
  readonly accounts: readonly AccountView[];
  readonly actions: AppActions;
  readonly now: number;
  /** When each call started being set up, so a call that is not answered yet can show how long it has waited. */
  readonly setupStarts: ReadonlyMap<string, number>;
}

function accountOf(env: LineEnv, line: Line): { readonly view: AccountView | undefined; readonly index: number } {
  const index = env.accounts.findIndex((a) => a.account.id === line.view.call.accountId);
  return { view: env.accounts[index], index: Math.max(index, 0) };
}

function Lamp({ state }: { readonly state: string }): JSX.Element {
  return <span className={cx('lamp', `lamp-${state}`)} aria-hidden="true" />;
}

/** Counts up from the answer, or from the start of setup while the call is still being put through. */
function CallTimer({ view, env }: { readonly view: CallView; readonly env: LineEnv }): JSX.Element | null {
  const { t } = useTranslation();
  const pending = isPending(view);
  const since = view.connectedAt ?? (pending ? env.setupStarts.get(view.call.id) : undefined);
  if (since === undefined) return null;
  return (
    <span className={cx('timer', pending && 'timer-setup')} role="timer">
      <span className="sr-only">{t('calls.duration')} </span>
      {formatDuration(env.now - since)}
    </span>
  );
}

function MediaMeter({ media }: { readonly media: CallView['media'] }): JSX.Element | null {
  const { t } = useTranslation();
  if (media === undefined) return null;
  const flowing = media.rxPackets + media.txPackets > 0;
  const rx = media.rxPackets.toLocaleString();
  const tx = media.txPackets.toLocaleString();
  return (
    <p className="media">
      <span className={cx('meter', flowing && 'meter-on')} aria-hidden="true"><i /><i /><i /></span>
      <span>{flowing ? t('media.flowing', { rx, tx }) : t('media.silent')}</span>
      {media.lostPackets > 0 ? <span className="media-lost">{t('media.lost', { lost: media.lostPackets })}</span> : null}
    </p>
  );
}

function LineMeta({ line, env }: { readonly line: Line; readonly env: LineEnv }): JSX.Element {
  const { t } = useTranslation();
  const { view, index } = accountOf(env, line);
  return (
    <span className="line-meta">
      <span>{t('calls.line', { number: line.slot })}</span>
      <Avatar name={view?.account.displayName ?? ''} hue={index} />
      <span>{view?.account.displayName}</span>
      <span>{t(`calls.direction.${line.view.call.direction}`)}</span>
    </span>
  );
}

const GIVES_UP = 'calls.progress.givesUp'; // i18n-exempt: translation key

function Progress({ view }: { readonly view: CallView }): JSX.Element | null {
  const { t } = useTranslation();
  const key = progressKey(view);
  if (key === null) return null;
  return (
    <>
      <span className={cx('progress', isPending(view) && 'progress-pending')}>
        {isPending(view) ? <i className="spinner" aria-hidden="true" /> : null}
        {t(key)}
      </span>
      {isWaiting(view) ? <span className="progress-hint">{t(GIVES_UP)}</span> : null}
    </>
  );
}

function LineSummary({ line, env }: { readonly line: Line; readonly env: LineEnv }): JSX.Element {
  const { t } = useTranslation();
  const { call } = line.view;
  return (
    <>
      <Lamp state={call.state} />
      <span className="line-main">
        <Breakable className="line-name" text={call.remoteIdentity} titled />
        <Progress view={line.view} />
        <LineMeta line={line} env={env} />
      </span>
      <span className="line-state">
        <span className={cx('state', `state-${call.state}`)}>{t(callStateKey(call.state))}</span>
        <CallTimer view={line.view} env={env} />
      </span>
    </>
  );
}

export function LineRow({ line, env, onSelect }: { readonly line: Line; readonly env: LineEnv; readonly onSelect: (id: string) => void }): JSX.Element {
  const { t } = useTranslation();
  const ringing = isIncomingRing(line);
  return (
    <li>
      <button type="button" className={cx('line', ringing && 'line-ringing')} onClick={() => onSelect(line.view.call.id)} title={t('calls.switchTo')} disabled={ringing}>
        <LineSummary line={line} env={env} />
      </button>
    </li>
  );
}

function LiveControls({ view, actions }: { readonly view: CallView; readonly actions: AppActions }): JSX.Element {
  const { t } = useTranslation();
  const { call, media } = view;
  const muted = media?.muted ?? false;
  const held = call.state === 'held';
  // i18n-exempt: icon name
  const micIcon = muted ? 'micOff' : 'mic';
  return (
    <>
      <Button tile pressed={muted} icon={micIcon} label={muted ? t('calls.unmute') : t('calls.mute')} onClick={() => void actions.mute(call.id, !muted)} />
      <Button tile pressed={held} icon={held ? 'play' : 'pause'} label={held ? t('calls.resume') : t('calls.hold')} onClick={() => void (held ? actions.resume(call.id) : actions.hold(call.id))} />
    </>
  );
}

export function FocusedLine({ line, env }: { readonly line: Line; readonly env: LineEnv }): JSX.Element {
  const { t } = useTranslation();
  const [pad, setPad] = useState(false);
  const { call } = line.view;
  const live = call.state === 'active' || call.state === 'held';
  return (
    <li className="line-focused">
      <div className="line line-head"><LineSummary line={line} env={env} /></div>
      <MediaMeter media={line.view.media} />
      <div className="controls">
        {live ? <LiveControls view={line.view} actions={env.actions} /> : null}
        {live ? <Button tile pressed={pad} icon="keypad" label={t('calls.keypad')} onClick={() => setPad(!pad)} /> : null}
        <Button tile variant="danger" icon="hangup" label={t('calls.hangup')} onClick={() => void env.actions.hangup(call.id)} />
      </div>
      {live && pad ? <Keypad label={t('calls.keypad')} onDigit={(d) => void env.actions.dtmf(call.id, d)} /> : null}
    </li>
  );
}
