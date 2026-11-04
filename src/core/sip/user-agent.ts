/*
 * The User-Agent we identify as. Carriers and SBCs commonly filter on it as an anti-fraud measure, so it has
 * to be something the user can change; it is a setting, not a constant. The value is plain text that ends up
 * in a header line, so it is cleaned here, once, and everything downstream can trust it.
 */
export const DEFAULT_USER_AGENT = 'OpenSIPPhone/0.1.0';

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
