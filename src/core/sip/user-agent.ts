/*
 * The User-Agent we identify as. Carriers and SBCs commonly filter on it as an anti-fraud measure, so it has
 * to be something the user can change; it is a setting, not a constant. The value is plain text that ends up
 * in a header line, so it is cleaned here, once, and everything downstream can trust it.
 */

/**
 * A third-party identity, the default, because it is measured: a Zoiper 5 call carrying exactly this value connected
 * against one OpenSIPS 3.3.10 server that silently discarded the identical INVITE under our own. It is labelled
 * for what it does (a compatibility identity), never as recommended or safe.
 */
export const ZOIPER_USER_AGENT = 'Z 5.6.16 v2.10.20.18';

/** What a fresh install sends; the single source every message, placeholder and test reads. */
export const DEFAULT_USER_AGENT = ZOIPER_USER_AGENT;

export const MAX_USER_AGENT_LENGTH = 128;

const CONTROL_RUN = /\p{Cc}+/gu;

/** Trims, turns control characters (CR and LF above all: header injection) into spaces, and bounds the length. Blank stays blank. */
export function normaliseUserAgent(value: string): string {
  return value.replace(CONTROL_RUN, ' ').trim().slice(0, MAX_USER_AGENT_LENGTH).trim();
}

/** What goes on the wire for a stored setting: the default when it is blank. */
export function effectiveUserAgent(setting: string): string {
  const clean = normaliseUserAgent(setting);
  return clean === '' ? DEFAULT_USER_AGENT : clean;
}

/** The OPENSIP_USER_AGENT environment variable, as the initial value of the setting before the user has chosen one. */
export function userAgentFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  return normaliseUserAgent(env['OPENSIP_USER_AGENT'] ?? '');
}

/** Our own name and version. */
export const OWN_USER_AGENT = 'OpenSIPPhone/0.1.0';

/** The bare product token, for operators whose filters prefer one. */
export const BARE_USER_AGENT = 'OpenSIPPhone';

/** The identities offered in Settings, in order; the first is the default. Everything else is the Custom field. */
export const USER_AGENT_PRESETS: readonly string[] = [DEFAULT_USER_AGENT, OWN_USER_AGENT, BARE_USER_AGENT];

/** The i18n key of each preset's label; the label receives the value as {agent}. */
export const USER_AGENT_PRESET_LABEL_KEYS: Readonly<Record<string, string>> = {
  [DEFAULT_USER_AGENT]: 'settings.userAgent.preset.default',
  [OWN_USER_AGENT]: 'settings.userAgent.preset.own',
  [BARE_USER_AGENT]: 'settings.userAgent.preset.bare'
};

/** What the picker shows for a value that is none of the presets: the free-text field is revealed. */
export const CUSTOM_USER_AGENT_CHOICE = 'custom';

/** The picker entry for a stored setting: the preset it equals (a blank setting is the default), else Custom. */
export function userAgentChoice(setting: string): string {
  const effective = effectiveUserAgent(setting);
  return USER_AGENT_PRESETS.find((preset) => preset === effective) ?? CUSTOM_USER_AGENT_CHOICE;
}

/** What to store for a preset: blank for the default, so it keeps following the app's version. */
export function presetToSetting(preset: string): string {
  return preset === DEFAULT_USER_AGENT ? '' : preset;
}
