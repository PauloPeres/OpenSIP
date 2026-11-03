import { manualCandidate } from './transport';
import type { AccountId, SipAccount, SipAccountInput, ValidationIssue } from './types';

export const DEFAULT_REGISTER_EXPIRES = 600;
export const MIN_REGISTER_EXPIRES = 60;
export const MAX_REGISTER_EXPIRES = 3600;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

export class AccountValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('account-validation');
    this.name = 'AccountValidationError';
    this.issues = issues;
  }
}

interface Rule {
  readonly field: keyof SipAccountInput;
  readonly messageKey: string;
  readonly valid: (input: SipAccountInput) => boolean;
}

const filled = (value: string): boolean => value.trim() !== '';
const isDomain = (value: string): boolean => !filled(value) || DOMAIN_PATTERN.test(value.trim());
const trimmedServerUri = (value: string | undefined): string => (value ?? '').trim();
const isServerUri = (value: string | undefined): boolean => {
  const uri = trimmedServerUri(value);
  if (uri === '') return true;
  try {
    manualCandidate(uri);
    return true;
  } catch {
    return false;
  }
};
const isExpiry = (value: number): boolean =>
  Number.isInteger(value) && value >= MIN_REGISTER_EXPIRES && value <= MAX_REGISTER_EXPIRES;

const RULES: readonly Rule[] = [
  { field: 'displayName', messageKey: 'accounts.validation.displayNameRequired', valid: (i) => filled(i.displayName) },
  { field: 'username', messageKey: 'accounts.validation.usernameRequired', valid: (i) => filled(i.username) },
  { field: 'password', messageKey: 'accounts.validation.passwordRequired', valid: (i) => i.password !== '' },
  { field: 'domain', messageKey: 'accounts.validation.domainRequired', valid: (i) => filled(i.domain) },
  { field: 'domain', messageKey: 'accounts.validation.domainInvalid', valid: (i) => isDomain(i.domain) },
  { field: 'serverUri', messageKey: 'accounts.validation.serverUriInvalid', valid: (i) => isServerUri(i.serverUri) },
  {
    field: 'registerExpires',
    messageKey: 'accounts.validation.expiresOutOfRange',
    valid: (i) => isExpiry(i.registerExpires ?? DEFAULT_REGISTER_EXPIRES)
  }
];

export function validateAccountInput(input: SipAccountInput): readonly ValidationIssue[] {
  return RULES.filter((rule) => !rule.valid(input)).map(({ field, messageKey }) => ({ field, messageKey }));
}

export function accountKey(input: Pick<SipAccountInput, 'username' | 'domain'>): string {
  return `${input.username}@${input.domain}`.toLowerCase();
}

export function createAccount(input: SipAccountInput, id: AccountId): SipAccount {
  const issues = validateAccountInput(input);
  if (issues.length > 0) throw new AccountValidationError(issues);
  const username = input.username.trim();
  const domain = input.domain.trim();
  const serverUri = trimmedServerUri(input.serverUri);
  return {
    id,
    displayName: input.displayName.trim(),
    username,
    password: input.password,
    domain,
    ...(serverUri === '' ? {} : { serverUri }),
    registerExpires: input.registerExpires ?? DEFAULT_REGISTER_EXPIRES,
    uri: `sip:${username}@${domain}`
  };
}
