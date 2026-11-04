import { useEffect, useState } from 'react';
import {
  CUSTOM_USER_AGENT_CHOICE,
  DEFAULT_USER_AGENT,
  MAX_USER_AGENT_LENGTH,
  USER_AGENT_PRESETS,
  USER_AGENT_PRESET_LABEL_KEYS,
  effectiveUserAgent,
  presetToSetting,
  userAgentChoice
} from '../../../shared/api';
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
  /** Records a value stored by some other control, so the field and the confirmation follow it. */
  readonly keep: (kept: string) => void;
}

/** Follows the stored value, and writes only when the user is done editing (blur or Enter), not per keystroke. */
function useDraft({ value, save }: UserAgentPref): Draft {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  useEffect(() => setText(value), [value]);
  const keep = (kept: string): void => {
    setText(kept);
    setSaved(kept);
  };
  const commit = (): void => {
    if (effectiveUserAgent(text) === effectiveUserAgent(value)) return;
    save(text)
      .then(keep)
      .catch(() => undefined);
  };
  const edit = (next: string): void => {
    setText(next);
    setSaved(undefined);
  };
  return { text, setText: edit, saved, commit, keep };
}

interface Picker {
  /** A preset's value, or CUSTOM_USER_AGENT_CHOICE while the free-text field is showing. */
  readonly choice: string;
  /** True when the user has just opened Custom, so the field it reveals should take the keyboard. */
  readonly opened: boolean;
  readonly pick: (next: string) => void;
}

/** The picker follows the stored value, except that Custom stays open while the user is typing a value that happens to equal a preset. */
function usePicker({ value, save }: UserAgentPref, draft: Draft): Picker {
  const [choice, setChoice] = useState(userAgentChoice(value));
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    setChoice((current) => (current === CUSTOM_USER_AGENT_CHOICE ? current : userAgentChoice(value)));
  }, [value]);
  const pick = (next: string): void => {
    const custom = next === CUSTOM_USER_AGENT_CHOICE;
    if (custom && choice !== next) draft.setText(choice);
    setOpened(custom);
    setChoice(next);
    if (!custom) save(presetToSetting(next)).then(draft.keep).catch(() => undefined);
  };
  return { choice, opened, pick };
}

function PresetSelect({ picker }: { readonly picker: Picker }): JSX.Element {
  const { t } = useTranslation();
  return (
    <select id="user-agent-preset" value={picker.choice} aria-describedby="user-agent-hint" onChange={(event) => picker.pick(event.target.value)}>
      {USER_AGENT_PRESETS.map((preset) => (
        <option key={preset} value={preset}>
          {t(USER_AGENT_PRESET_LABEL_KEYS[preset] ?? '', { agent: preset })}
        </option>
      ))}
      <option value={CUSTOM_USER_AGENT_CHOICE}>{t('settings.userAgent.custom')}</option>
    </select>
  );
}

function AgentInput({ draft, focus }: { readonly draft: Draft; readonly focus: boolean }): JSX.Element {
  const { t } = useTranslation();
  return (
    <input
      id="user-agent"
      type="text"
      value={draft.text}
      maxLength={MAX_USER_AGENT_LENGTH}
      spellCheck={false}
      autoCapitalize="off"
      autoFocus={focus}
      aria-label={t('settings.userAgent')}
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
  const picker = usePicker(pref, draft);
  const custom = picker.choice === CUSTOM_USER_AGENT_CHOICE;
  const agent = draft.saved === undefined ? undefined : draft.saved || DEFAULT_USER_AGENT;
  return (
    <FormField id="user-agent-preset" label={t('settings.userAgent')}>
      <PresetSelect picker={picker} />
      {custom ? <AgentInput draft={draft} focus={picker.opened} /> : null}
      <span id="user-agent-hint" className="hint">{t('settings.userAgent.hint')}</span>
      {picker.choice === DEFAULT_USER_AGENT ? <span className="hint">{t('settings.userAgent.identity', { agent: DEFAULT_USER_AGENT })}</span> : null}
      <span className="hint" role="status">{agent === undefined ? '' : t('settings.userAgent.saved', { agent })}</span>
    </FormField>
  );
}
