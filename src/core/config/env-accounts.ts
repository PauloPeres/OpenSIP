import type { SipAccountInput } from '@core/sip';

export interface EnvAccountDraft {
  readonly input: SipAccountInput;
  readonly index: number;
}

export const MAX_ENV_ACCOUNTS = 9;

type Env = Readonly<Record<string, string | undefined>>;

function field(env: Env, index: number, name: string): string {
  return (env[`OPENSIP_ACCOUNT_${index}_${name}`] ?? '').trim();
}

function parseExpires(raw: string): { registerExpires?: number } {
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? {} : { registerExpires: value };
}

function serverUriField(env: Env, index: number): { serverUri?: string } {
  const serverUri = field(env, index, 'SERVER_URI') || field(env, index, 'WS_SERVER');
  return serverUri === '' ? {} : { serverUri };
}

function isComplete(parts: readonly string[]): boolean {
  return parts.every((part) => part !== '');
}

function parseOne(env: Env, index: number): EnvAccountDraft | undefined {
  const username = field(env, index, 'USERNAME');
  const password = field(env, index, 'PASSWORD');
  const domain = field(env, index, 'DOMAIN');
  if (!isComplete([username, password, domain])) return undefined;
  const displayName = field(env, index, 'DISPLAY_NAME') || username;
  const expires = parseExpires(field(env, index, 'REGISTER_EXPIRES'));
  return { index, input: { displayName, username, password, domain, ...serverUriField(env, index), ...expires } };
}

export function parseEnvAccounts(env: Env): readonly EnvAccountDraft[] {
  const indexes = Array.from({ length: MAX_ENV_ACCOUNTS }, (_, i) => i + 1);
  return indexes.map((index) => parseOne(env, index)).filter((d): d is EnvAccountDraft => d !== undefined);
}
