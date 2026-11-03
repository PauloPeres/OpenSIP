import { describe, expect, it } from 'vitest';
import {
  AccountValidationError,
  accountKey,
  createAccount,
  validateAccountInput
} from '../../src/core/sip/account';
import type { SipAccountInput } from '../../src/core/sip/types';

const valid: SipAccountInput = {
  displayName: 'Work',
  username: 'alice',
  password: 's3cret',
  domain: 'sip.example.com'
};

const keys = (input: SipAccountInput): string[] =>
  validateAccountInput(input).map((i) => `${i.field}:${i.messageKey}`);

describe('validateAccountInput', () => {
  it('accepts a valid input', () => {
    expect(validateAccountInput(valid)).toEqual([]);
  });

  it.each([
    ['displayName', 'accounts.validation.displayNameRequired'],
    ['username', 'accounts.validation.usernameRequired'],
    ['password', 'accounts.validation.passwordRequired'],
    ['domain', 'accounts.validation.domainRequired']
  ] as const)('requires %s', (field, key) => {
    expect(keys({ ...valid, [field]: '' })).toEqual([`${field}:${key}`]);
    if (field !== 'password') {
      expect(keys({ ...valid, [field]: '   ' })).toEqual([`${field}:${key}`]);
    }
  });

  it('does not trim the password', () => {
    expect(keys({ ...valid, password: ' a ' })).toEqual([]);
  });

  it.each(['sip example.com', '-bad.com', 'bad-.com', 'a..b', 'a.com:abc', 'a.com:123456'])(
    'rejects domain %s',
    (domain) => {
      expect(keys({ ...valid, domain })).toEqual(['domain:accounts.validation.domainInvalid']);
    }
  );

  it.each(['localhost', 'sip.example.com', 'a-b.example.com', '10.0.0.1', 'sip.example.com:5060'])(
    'accepts domain %s',
    (domain) => {
      expect(keys({ ...valid, domain })).toEqual([]);
    }
  );

  it('accepts an account with only username, password and domain', () => {
    expect(
      validateAccountInput({
        displayName: 'Work',
        username: 'alice',
        password: 's3cret',
        domain: 'sip.example.com'
      })
    ).toEqual([]);
  });

  it.each([undefined, '', '   '])('treats serverUri %j as "discover the transport"', (serverUri) => {
    const input = serverUri === undefined ? valid : { ...valid, serverUri };
    expect(keys(input)).toEqual([]);
  });

  it.each([
    'tcp://pbx:5060',
    'wss://pbx:8089/ws',
    'ws://host:80',
    'wss://host',
    'tls://host:5061',
    'udp://host',
    ' tcp://host '
  ])('accepts serverUri "%s"', (serverUri) => {
    expect(keys({ ...valid, serverUri })).toEqual([]);
  });

  it.each(['ftp://pbx:21', 'http://x.com', 'wss://', 'tcp://'])(
    'rejects serverUri "%s"',
    (serverUri) => {
      expect(keys({ ...valid, serverUri })).toEqual(['serverUri:accounts.validation.serverUriInvalid']);
    }
  );

  it.each([60, 61, 600, 3599, 3600])('accepts registerExpires %d', (registerExpires) => {
    expect(keys({ ...valid, registerExpires })).toEqual([]);
  });

  it.each([59, 3601, 0, -1, 60.5, Number.NaN])('rejects registerExpires %s', (registerExpires) => {
    expect(keys({ ...valid, registerExpires })).toEqual([
      'registerExpires:accounts.validation.expiresOutOfRange'
    ] as string[]);
  });

  it('reports every issue at once, in field order', () => {
    const fields = validateAccountInput({
      ...valid,
      displayName: '',
      username: '',
      serverUri: 'ftp://x'
    }).map((i) => i.field);
    expect(fields).toEqual(['displayName', 'username', 'serverUri']);
  });
});

describe('createAccount', () => {
  it('builds the account, uri and default expiry', () => {
    expect(createAccount(valid, 'id-1')).toEqual({
      ...valid,
      id: 'id-1',
      registerExpires: 600,
      uri: 'sip:alice@sip.example.com'
    });
  });

  it.each([undefined, '', '   '])('omits the serverUri property when it is %j', (serverUri) => {
    const input = serverUri === undefined ? valid : { ...valid, serverUri };
    const account = createAccount(input, 'x');
    expect(Object.hasOwn(account, 'serverUri')).toBe(false);
    expect(Object.keys(account).sort()).toEqual(
      ['displayName', 'domain', 'id', 'password', 'registerExpires', 'uri', 'username']
    );
  });

  it('rejects an unsupported serverUri without leaking the transport error', () => {
    expect(() => createAccount({ ...valid, serverUri: 'ftp://pbx' }, 'x')).toThrow(
      AccountValidationError
    );
  });

  it('keeps an explicit expiry', () => {
    expect(createAccount({ ...valid, registerExpires: 60 }, 'x').registerExpires).toBe(60);
  });

  it('trims strings except the password', () => {
    const account = createAccount(
      {
        displayName: ' Work ',
        username: ' alice ',
        password: ' pw ',
        domain: ' sip.example.com ',
        serverUri: ' wss://h '
      },
      'x'
    );
    expect(account).toMatchObject({
      displayName: 'Work',
      username: 'alice',
      password: ' pw ',
      domain: 'sip.example.com',
      serverUri: 'wss://h',
      uri: 'sip:alice@sip.example.com'
    });
  });

  it('throws AccountValidationError carrying the issues', () => {
    const attempt = (): unknown => createAccount({ ...valid, username: '' }, 'x');
    expect(attempt).toThrow(AccountValidationError);
    try {
      attempt();
    } catch (error) {
      expect((error as AccountValidationError).issues).toEqual([
        { field: 'username', messageKey: 'accounts.validation.usernameRequired' }
      ]);
      expect((error as Error).name).toBe('AccountValidationError');
    }
  });
});

describe('accountKey', () => {
  it('lowercases username@domain', () => {
    expect(accountKey({ username: 'Alice', domain: 'SIP.Example.COM' })).toBe(
      'alice@sip.example.com'
    );
  });
});
