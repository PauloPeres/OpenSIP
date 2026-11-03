export const DEFAULT_USER_AGENT = 'OpenSIPPhone/0.1.0';

/** Diagnostic lever: OPENSIP_USER_AGENT replaces the User-Agent we send; blank or unset keeps the default. */
export function resolveUserAgent(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['OPENSIP_USER_AGENT']?.trim();
  return override === undefined || override === '' ? DEFAULT_USER_AGENT : override;
}

/** Read once at startup; every SIP message we build takes its User-Agent from here. */
export const USER_AGENT: string = resolveUserAgent(process.env);
