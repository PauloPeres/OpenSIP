import { useEffect, useState } from 'react';
import type { AccountDraft, SaveAccountResult } from '../../../shared/api';
import { Mark } from '../brand/Logo';
import { useTranslation } from '../i18n/TranslatorProvider';
import { usePermissions } from '../state/permissions';
import type { PermState, PermissionsModel } from '../state/permissions';
import { AccountForm } from './AccountForm';
import { DeniedHint, PermBadge } from './PermissionStatus';
import { Button } from './ui/Button';
import { cx } from './ui/cx';

interface StepDef {
  readonly titleKey: string;
  readonly whyKey: string;
}

const MIC: StepDef = { titleKey: 'onboarding.step.microphone', whyKey: 'onboarding.step.microphoneWhy' }; // i18n-exempt: translation key
const NOTIFY: StepDef = { titleKey: 'onboarding.step.notifications', whyKey: 'onboarding.step.notificationsWhy' }; // i18n-exempt: translation key
const ACCOUNT: StepDef = { titleKey: 'onboarding.step.account', whyKey: 'onboarding.step.accountWhy' }; // i18n-exempt: translation key
const STEPS: readonly StepDef[] = [MIC, NOTIFY, ACCOUNT];

function StepList({ step }: { readonly step: number }): JSX.Element {
  const { t } = useTranslation();
  return (
    <ol className="steps">
      {STEPS.map((def, index) => (
        <li key={def.titleKey} className={cx('step', index === step && 'step-current', index < step && 'step-done')} aria-current={index === step ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true" />
          {t(def.titleKey)}
        </li>
      ))}
    </ol>
  );
}

interface PermissionStepProps {
  readonly def: StepDef;
  readonly state: PermState;
  readonly settings: boolean;
  readonly onAllow: () => Promise<void>;
  readonly onNext: () => void;
}

/** Moves on by itself once the grant arrives; a denial stays put so the hint can be read. */
function useAdvanceOnGrant(state: PermState, onNext: () => void): void {
  useEffect(() => {
    if (state === 'granted') onNext();
  }, [state, onNext]);
}

function PermissionStep({ def, state, settings, onAllow, onNext }: PermissionStepProps): JSX.Element {
  const { t } = useTranslation();
  useAdvanceOnGrant(state, onNext);
  return (
    <div className="step-body">
      <h2 className="step-title">{t(def.titleKey)}</h2>
      <p className="muted">{t(def.whyKey)}</p>
      <p><PermBadge state={state} /></p>
      <DeniedHint state={state} settings={settings} />
      <div className="row">
        {state === 'pending' ? <Button variant="primary" label={t('onboarding.allow')} onClick={() => void onAllow()} /> : null}
        {state === 'pending' ? <Button label={t('onboarding.skip')} onClick={onNext} /> : <Button variant="primary" label={t('onboarding.next')} onClick={onNext} />}
      </div>
    </div>
  );
}

interface AccountStepProps {
  readonly onSave: (draft: AccountDraft) => Promise<SaveAccountResult>;
  readonly onFinish: () => void;
}

function AccountStep({ onSave, onFinish }: AccountStepProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="step-body">
      <h2 className="step-title">{t(ACCOUNT.titleKey)}</h2>
      <p className="muted">{t(ACCOUNT.whyKey)}</p>
      <AccountForm onSave={onSave} onDone={onFinish} saveKey="onboarding.finish" cancelKey="onboarding.skip" />
    </div>
  );
}

interface BodyProps extends AccountStepProps {
  readonly step: number;
  readonly perms: PermissionsModel;
  readonly goTo: (step: number) => void;
}

function StepBody({ step, perms, goTo, onSave, onFinish }: BodyProps): JSX.Element {
  if (step === 2) return <AccountStep onSave={onSave} onFinish={onFinish} />;
  const mic = step === 0;
  return (
    <PermissionStep
      def={mic ? MIC : NOTIFY}
      state={mic ? perms.microphone : perms.notifications}
      settings={mic}
      onAllow={mic ? perms.askMicrophone : perms.askNotifications}
      onNext={() => goTo(step + 1)}
    />
  );
}

export function Onboarding({ onSave, onFinish }: AccountStepProps): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const perms = usePermissions();
  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <Mark size={48} decorative />
        <h1 className="onboarding-title">{t('onboarding.title')}</h1>
        <p className="muted">{t('onboarding.subtitle')}</p>
        <StepList step={step} />
        <StepBody step={step} perms={perms} goTo={setStep} onSave={onSave} onFinish={onFinish} />
      </div>
    </main>
  );
}
