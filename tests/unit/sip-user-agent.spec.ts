import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccount, headerValue } from '../../src/core/sip';
import {
  DEFAULT_USER_AGENT,
  MAX_USER_AGENT_LENGTH,
  effectiveUserAgent,
  normaliseUserAgent,
  userAgentFromEnv
} from '../../src/core/sip';

vi.mock('../../src/main/windows', () => ({ log: (): void => undefined }));

describe('the User-Agent setting, as a value', () => {
  it('has the documented default', () => {
    expect(DEFAULT_USER_AGENT).toBe('OpenSIPPhone/0.1.0');
  });

  it('trims, and turns blank into blank (meaning: use the default)', () => {
    expect(normaliseUserAgent('  Z 5.6.16 v2.10.20.18  ')).toBe('Z 5.6.16 v2.10.20.18');
    expect(normaliseUserAgent('   ')).toBe('');
  });

  it('cannot smuggle a header: CR, LF and other control characters become spaces', () => {
    expect(normaliseUserAgent('X/1\r\nRoute: <sip:evil>')).toBe('X/1 Route: <sip:evil>');
    expect(normaliseUserAgent('\u0000\u0007A\tB\u007f')).toBe('A B');
  });

  it('is bounded', () => {
    expect(normaliseUserAgent('a'.repeat(500))).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(normaliseUserAgent(`${'a'.repeat(MAX_USER_AGENT_LENGTH - 1)}  b`)).toBe('a'.repeat(MAX_USER_AGENT_LENGTH - 1));
  });

  it('falls back to the default only when the setting is empty', () => {
    expect(effectiveUserAgent('')).toBe(DEFAULT_USER_AGENT);
    expect(effectiveUserAgent('  ')).toBe(DEFAULT_USER_AGENT);
    expect(effectiveUserAgent('X/1')).toBe('X/1');
  });

  it('reads the initial value from OPENSIP_USER_AGENT, blank or unset meaning none', () => {
    expect(userAgentFromEnv({})).toBe('');
    expect(userAgentFromEnv({ OPENSIP_USER_AGENT: '  X/1  ' })).toBe('X/1');
    expect(userAgentFromEnv({ OPENSIP_USER_AGENT: ' ' })).toBe('');
  });
});

describe('the User-Agent on the wire follows the setting, not the process start', () => {
  const account = createAccount({ displayName: 'Me', username: '1000', password: 's', domain: 'pbx.test' }, 'acc1');
  const candidate = { transport: 'udp', host: 'pbx.test', port: 5060, source: 'manual', weight: 0, srvPriority: 0 } as never;
  const ids = { newBranch: () => 'z9hG4bKb', newTag: () => 't', newCallId: (h: string) => `c@${h}`, newCnonce: () => 'n' };

  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  async function load() {
    const agent = await import('../../src/main/sip/user-agent');
    const registrar = await import('../../src/main/sip/registrar');
    const prober = await import('../../src/main/sip/prober');
    const register = (): string | undefined =>
      headerValue(registrar.buildRegisterRequest({ account, candidate, expires: 300, localAddress: { host: '10.0.0.5', port: 5060 } }, ids, 1).headers, 'user-agent');
    const probe = (): string => prober.buildOptionsProbe('pbx.test', 5060, 'z9hG4bKp');
    return { agent, register, probe };
  }

  it('starts from OPENSIP_USER_AGENT when it is set, and from the default when it is not', async () => {
    vi.stubEnv('OPENSIP_USER_AGENT', 'Z 5.6.16 v2.10.20.18');
    const withEnv = await load();
    expect(withEnv.agent.initialUserAgentSetting()).toBe('Z 5.6.16 v2.10.20.18');
    expect(withEnv.register()).toBe('Z 5.6.16 v2.10.20.18');
    vi.resetModules();
    vi.stubEnv('OPENSIP_USER_AGENT', '');
    const without = await load();
    expect(without.agent.initialUserAgentSetting()).toBe('');
    expect(without.register()).toBe(DEFAULT_USER_AGENT);
  });

  it('applies a change to the very next REGISTER and probe, and returning to blank restores the default', async () => {
    const { agent, register, probe } = await load();
    agent.setUserAgent('Linphone/5.0');
    expect(register()).toBe('Linphone/5.0');
    expect(probe()).toContain('User-Agent: Linphone/5.0\r\n');
    agent.setUserAgent('');
    expect(register()).toBe(DEFAULT_USER_AGENT);
    expect(probe()).toContain(`User-Agent: ${DEFAULT_USER_AGENT}\r\n`);
  });

  it('stores a cleaned value, so what is applied is what is persisted', async () => {
    const { agent, register } = await load();
    expect(agent.setUserAgent('  X/2\r\nEvil: 1 ')).toBe('X/2 Evil: 1');
    expect(register()).toBe('X/2 Evil: 1');
  });
});
