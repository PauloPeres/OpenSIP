import { describe, expect, it } from 'vitest';
import { MAX_ENV_ACCOUNTS, parseEnvAccounts } from '../../src/core/config/env-accounts';

const full = (n: number, extra: Record<string, string> = {}): Record<string, string> => ({
  [`OPENSIP_ACCOUNT_${n}_DISPLAY_NAME`]: `Name ${n}`,
  [`OPENSIP_ACCOUNT_${n}_USERNAME`]: `100${n}`,
  [`OPENSIP_ACCOUNT_${n}_PASSWORD`]: `pw${n}`,
  [`OPENSIP_ACCOUNT_${n}_DOMAIN`]: 'sip.example.com',
  [`OPENSIP_ACCOUNT_${n}_WS_SERVER`]: 'wss://sip.example.com:7443',
  ...extra
});

describe('parseEnvAccounts', () => {
  it('exposes the maximum number of accounts', () => {
    expect(MAX_ENV_ACCOUNTS).toBe(9);
  });

  it('returns nothing for an empty env', () => {
    expect(parseEnvAccounts({})).toEqual([]);
  });

  it('parses a complete account', () => {
    const [draft] = parseEnvAccounts({ ...full(1), OPENSIP_ACCOUNT_1_REGISTER_EXPIRES: '600' });
    expect(draft).toEqual({
      index: 1,
      input: {
        displayName: 'Name 1',
        username: '1001',
        password: 'pw1',
        domain: 'sip.example.com',
        wsServer: 'wss://sip.example.com:7443',
        registerExpires: 600
      }
    });
  });

  it('omits registerExpires when absent', () => {
    const [draft] = parseEnvAccounts(full(1));
    expect(draft?.input).not.toHaveProperty('registerExpires');
  });

  it.each(['abc', '', '   '])('omits registerExpires for %j', (raw) => {
    const [draft] = parseEnvAccounts(full(1, { OPENSIP_ACCOUNT_1_REGISTER_EXPIRES: raw }));
    expect(draft?.input).not.toHaveProperty('registerExpires');
  });

  it.each([
    ['60', 60],
    ['3600', 3600],
    [' 120 ', 120]
  ])('parses expires %j', (raw, expected) => {
    const [draft] = parseEnvAccounts(full(1, { OPENSIP_ACCOUNT_1_REGISTER_EXPIRES: raw }));
    expect(draft?.input.registerExpires).toBe(expected);
  });

  it('keeps an explicit zero expiry out of range handling to the validator', () => {
    const [draft] = parseEnvAccounts(full(1, { OPENSIP_ACCOUNT_1_REGISTER_EXPIRES: '0' }));
    expect(draft?.input.registerExpires).toBe(0);
  });

  it.each(['DISPLAY_NAME'])('defaults display name to username when %s is blank', (field) => {
    const [blank] = parseEnvAccounts(full(1, { [`OPENSIP_ACCOUNT_1_${field}`]: '   ' }));
    expect(blank?.input.displayName).toBe('1001');
    const env: Record<string, string | undefined> = full(1);
    delete env['OPENSIP_ACCOUNT_1_DISPLAY_NAME'];
    expect(parseEnvAccounts(env)[0]?.input.displayName).toBe('1001');
  });

  it.each(['USERNAME', 'PASSWORD', 'DOMAIN', 'WS_SERVER'])('skips an entry with blank %s', (field) => {
    expect(parseEnvAccounts(full(1, { [`OPENSIP_ACCOUNT_1_${field}`]: '  ' }))).toEqual([]);
  });

  it.each(['USERNAME', 'PASSWORD', 'DOMAIN', 'WS_SERVER'])('skips an entry with missing %s', (field) => {
    const env: Record<string, string | undefined> = full(1);
    env[`OPENSIP_ACCOUNT_1_${field}`] = undefined;
    expect(parseEnvAccounts(env)).toEqual([]);
  });

  it('trims values', () => {
    const [draft] = parseEnvAccounts(full(1, { OPENSIP_ACCOUNT_1_USERNAME: '  alice  ' }));
    expect(draft?.input.username).toBe('alice');
  });

  it('handles gaps and orders by index', () => {
    const drafts = parseEnvAccounts({ ...full(3), ...full(1) });
    expect(drafts.map((d) => d.index)).toEqual([1, 3]);
  });

  it('reads index 9 but ignores index 10 and 0', () => {
    const drafts = parseEnvAccounts({ ...full(9), ...full(10), ...full(0) });
    expect(drafts.map((d) => d.index)).toEqual([9]);
  });
});
