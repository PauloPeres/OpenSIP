import { describe, expect, it } from 'vitest';
import { MAX_ENV_ACCOUNTS, parseEnvAccounts } from '../../src/core/config/env-accounts';

const full = (n: number, extra: Record<string, string> = {}): Record<string, string> => ({
  [`OPENSIP_ACCOUNT_${n}_DISPLAY_NAME`]: `Name ${n}`,
  [`OPENSIP_ACCOUNT_${n}_USERNAME`]: `100${n}`,
  [`OPENSIP_ACCOUNT_${n}_PASSWORD`]: `pw${n}`,
  [`OPENSIP_ACCOUNT_${n}_DOMAIN`]: 'sip.example.com',
  [`OPENSIP_ACCOUNT_${n}_SERVER_URI`]: 'wss://sip.example.com:7443',
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
        serverUri: 'wss://sip.example.com:7443',
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

  it.each(['USERNAME', 'PASSWORD', 'DOMAIN'])('skips an entry with blank %s', (field) => {
    expect(parseEnvAccounts(full(1, { [`OPENSIP_ACCOUNT_1_${field}`]: '  ' }))).toEqual([]);
  });

  it.each(['USERNAME', 'PASSWORD', 'DOMAIN'])('skips an entry with missing %s', (field) => {
    const env: Record<string, string | undefined> = full(1);
    env[`OPENSIP_ACCOUNT_1_${field}`] = undefined;
    expect(parseEnvAccounts(env)).toEqual([]);
  });

  it.each(['SERVER_URI', 'WS_SERVER'])('omits serverUri when %s is absent or blank', (name) => {
    const env: Record<string, string | undefined> = full(1, { [`OPENSIP_ACCOUNT_1_${name}`]: '   ' });
    delete env['OPENSIP_ACCOUNT_1_SERVER_URI'];
    delete env['OPENSIP_ACCOUNT_1_WS_SERVER'];
    expect(parseEnvAccounts(env)[0]?.input).not.toHaveProperty('serverUri');
  });

  it('accepts the legacy WS_SERVER alias', () => {
    const env: Record<string, string | undefined> = full(1);
    delete env['OPENSIP_ACCOUNT_1_SERVER_URI'];
    env['OPENSIP_ACCOUNT_1_WS_SERVER'] = 'ws://legacy:80';
    expect(parseEnvAccounts(env)[0]?.input.serverUri).toBe('ws://legacy:80');
  });

  it('prefers SERVER_URI over the legacy WS_SERVER alias', () => {
    const [draft] = parseEnvAccounts(full(1, { OPENSIP_ACCOUNT_1_WS_SERVER: 'ws://legacy:80' }));
    expect(draft?.input.serverUri).toBe('wss://sip.example.com:7443');
  });

  it('falls back to WS_SERVER when SERVER_URI is blank', () => {
    const [draft] = parseEnvAccounts(
      full(1, { OPENSIP_ACCOUNT_1_SERVER_URI: ' ', OPENSIP_ACCOUNT_1_WS_SERVER: 'ws://legacy:80' })
    );
    expect(draft?.input.serverUri).toBe('ws://legacy:80');
  });

  it('seeds an entry that has only username, password and domain', () => {
    const [draft] = parseEnvAccounts({
      OPENSIP_ACCOUNT_2_USERNAME: 'u',
      OPENSIP_ACCOUNT_2_PASSWORD: 'p',
      OPENSIP_ACCOUNT_2_DOMAIN: 'pbx.local'
    });
    expect(draft?.input).toEqual({ displayName: 'u', username: 'u', password: 'p', domain: 'pbx.local' });
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
