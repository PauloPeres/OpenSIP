import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { isIncomingRing } from '../state/useLines';
import type { Line } from '../state/useLines';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

interface IncomingProps {
  readonly lines: readonly Line[];
  readonly accounts: readonly AccountView[];
  readonly onAnswer: (callId: string) => void;
  readonly onReject: (callId: string) => void;
}

function Incoming({ line, accountName, onAnswer, onReject }: Omit<IncomingProps, 'lines' | 'accounts'> & { readonly line: Line; readonly accountName: string }): JSX.Element {
  const { t } = useTranslation();
  const { id, remoteIdentity } = line.view.call;
  return (
    <div className="incoming" role="alert">
      <span className="incoming-ring"><Icon name="phone" /></span>
      <div className="incoming-text">
        <strong title={remoteIdentity}>{t('calls.incomingFrom', { caller: remoteIdentity })}</strong>
        <span>{t('calls.line', { number: line.slot })} / {accountName}</span>
      </div>
      <Button large variant="success" icon="phone" label={t('calls.answer')} onClick={() => onAnswer(id)} />
      <Button large variant="danger" icon="hangup" label={t('calls.reject')} onClick={() => onReject(id)} />
    </div>
  );
}

export function IncomingCalls({ lines, accounts, onAnswer, onReject }: IncomingProps): JSX.Element | null {
  const ringing = lines.filter(isIncomingRing);
  if (ringing.length === 0) return null;
  return (
    <div className="incoming-stack">
      {ringing.map((line) => {
        const account = accounts.find((a) => a.account.id === line.view.call.accountId);
        return <Incoming key={line.view.call.id} line={line} accountName={account?.account.displayName ?? ''} onAnswer={onAnswer} onReject={onReject} />;
      })}
    </div>
  );
}
