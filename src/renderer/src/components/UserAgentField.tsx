import { useEffect, useState } from 'react';
import { DEFAULT_USER_AGENT, MAX_USER_AGENT_LENGTH } from '../../../shared/api';
import { useTranslation } from '../i18n/TranslatorProvider';
import { FormField } from './ui/Field';

const ENTER = 'Enter'; // i18n-exempt: keyboard key name

export interface UserAgentPref {
  /** The stored setting; empty means the default is in use. */
  readonly value: string;
  /** Stores a new value and resolves with the cleaned value that was kept. */
  readonly save: (next: string) => Promise<string>;
}

interface Draft {
  readonly text: string;
  readonly setText: (next: string) => void;
  /** The value that was just stored, until the user types again. */
  readonly saved: string | undefined;
  readonly commit: () => void;
}

/** Follows the stored value, and writes only when the user is done editing (blur or Enter), not per keystroke. */
function useDraft({ value, save }: UserAgentPref): Draft {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text.trim() === value) return;
    save(text)
      .then((kept) => {
        setText(kept);
        setSaved(kept);
      })
      .catch(() => undefined);
  };
  const edit = (next: string): void => {
    setText(next);
    setSaved(undefined);
  };
  return { text, setText: edit, saved, commit };
}

function AgentInput({ draft }: { readonly draft: Draft }): JSX.Element {
  const { t } = useTranslation();
  return (
    <input
      id="user-agent"
      type="text"
      value={draft.text}
      maxLength={MAX_USER_AGENT_LENGTH}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder={t('settings.userAgent.placeholder', { agent: DEFAULT_USER_AGENT })}
      aria-describedby="user-agent-hint"
      onChange={(event) => draft.setText(event.target.value)}
      onBlur={draft.commit}
      onKeyDown={(event) => event.key === ENTER && draft.commit()}
    />
  );
}

export function UserAgentField({ pref }: { readonly pref: UserAgentPref }): JSX.Element {
  const { t } = useTranslation();
  const draft = useDraft(pref);
  const agent = draft.saved === undefined ? undefined : draft.saved || DEFAULT_USER_AGENT;
  return (
    <FormField id="user-agent" label={t('settings.userAgent')}>
      <AgentInput draft={draft} />
      <span id="user-agent-hint" className="hint">{t('settings.userAgent.hint')}</span>
      <span className="hint" role="status">{agent === undefined ? '' : t('settings.userAgent.saved', { agent })}</span>
    </FormField>
  );
}
