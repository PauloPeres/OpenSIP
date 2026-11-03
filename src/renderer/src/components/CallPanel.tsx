import type { CallSession } from '@core/sip';
import { callStateKey } from '@core/sip';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { AppActions } from '../state/useAppState';
import { ActionButton, StatusBadge } from './StatusBadge';
import type { ButtonVariant } from './StatusBadge';

type CallActionName = 'answer' | 'reject' | 'hangup' | 'hold' | 'resume';

const LABEL_KEYS: Readonly<Record<CallActionName, string>> = {
  answer: 'calls.answer',
  reject: 'calls.reject',
  hangup: 'calls.hangup',
  hold: 'calls.hold',
  resume: 'calls.resume'
};

const VARIANTS: Readonly<Record<CallActionName, ButtonVariant>> = {
  answer: 'primary',
  reject: 'danger',
  hangup: 'danger',
  hold: 'default',
  resume: 'primary'
};

const ACTIONS_BY_STATE: Readonly<Record<CallSession['state'], readonly CallActionName[]>> = {
  ringing: ['answer', 'reject'],
  connecting: ['hangup'],
  active: ['hold', 'hangup'],
  held: ['resume', 'hangup'],
  ended: []
};

interface CallRowProps {
  readonly call: CallSession;
  readonly actions: AppActions;
}

function CallRow({ call, actions }: CallRowProps): JSX.Element {
  const { t } = useTranslation();
  const title = call.state === 'ringing' ? t('calls.incomingFrom', { caller: call.remoteIdentity }) : call.remoteIdentity;
  return (
    <li className="card row">
      <strong className="grow">{title}</strong>
      <StatusBadge tone={call.state} label={t(callStateKey(call.state))} />
      {ACTIONS_BY_STATE[call.state].map((name) => (
        <ActionButton
          key={name}
          label={t(LABEL_KEYS[name])}
          variant={VARIANTS[name]}
          onClick={() => void actions[name](call.id)}
        />
      ))}
    </li>
  );
}

export function CallPanel({ calls, actions }: { readonly calls: readonly CallSession[]; readonly actions: AppActions }): JSX.Element {
  const { t } = useTranslation();
  if (calls.length === 0) return <p className="muted">{t('calls.none')}</p>;
  return (
    <ul className="list">
      {calls.map((call) => (
        <CallRow key={call.id} call={call} actions={actions} />
      ))}
    </ul>
  );
}
