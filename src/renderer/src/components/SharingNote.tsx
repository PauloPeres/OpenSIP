import type { AccountView } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { sharingOf } from '../state/accountState';

/** The serious one: the account looks registered but will not receive calls. */
export function DisplacedNote({ withHint = false }: { readonly withHint?: boolean }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <span className="progress progress-bad">{t('accounts.displaced')}</span>
      {withHint ? <span className="muted">{t('accounts.displacedHint')}</span> : null}
    </>
  );
}

const SHARED_KEYS = {
  one: 'accounts.sharedWith', // i18n-exempt: translation key
  many: 'accounts.sharedWithMany' // i18n-exempt: translation key
} as const;

function SharedNote({ others }: { readonly others: number }): JSX.Element {
  const { t } = useTranslation();
  return (
    <p className="sharing sharing-shared" role="status">
      <strong>{t(others === 1 ? SHARED_KEYS.one : SHARED_KEYS.many, { count: others })}</strong>
      <span>{t('accounts.sharedHint')}</span>
    </p>
  );
}

/** Account-row notice: a loud alert when displaced, a quiet note when merely shared. */
export function SharingNote({ view }: { readonly view: AccountView }): JSX.Element | null {
  const sharing = sharingOf(view);
  if (sharing === null) return null;
  if (sharing.displaced) {
    return (
      <p className="sharing sharing-displaced" role="alert">
        <DisplacedNote withHint />
      </p>
    );
  }
  return sharing.others > 0 ? <SharedNote others={sharing.others} /> : null;
}
