import { effectiveUserAgent, normaliseUserAgent, userAgentFromEnv } from '@core/sip';

/**
 * The User-Agent every SIP message we build carries. Read at the moment a message is built, never captured,
 * so a change in Settings applies to the next message with no restart.
 */
const state = { setting: userAgentFromEnv(process.env) };

/** What the setting holds before the user has chosen one: the OPENSIP_USER_AGENT environment variable, or blank. */
export const initialUserAgentSetting = (): string => userAgentFromEnv(process.env);

/** Stores the setting (cleaned; blank means the default) and returns what was stored. */
export function setUserAgent(value: string): string {
  state.setting = normaliseUserAgent(value);
  return state.setting;
}

export const userAgentSetting = (): string => state.setting;

export const currentUserAgent = (): string => effectiveUserAgent(state.setting);
