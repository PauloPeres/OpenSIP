import { describe, expect, it } from 'vitest';
import { pickRedialAccount, redialTarget } from '../../src/core/history';

describe('redialTarget: identities that can be dialled', () => {
  it.each([
    ['sip:1001@pbx.test', 'sip:1001@pbx.test'],
    ['sips:alice@example.com', 'sips:alice@example.com'],
    ['SIP:Bob@example.com', 'SIP:Bob@example.com'],
    ['alice@example.com', 'alice@example.com'],
    ['1001@pbx.test', '1001@pbx.test'],
    ['1001', '1001'],
    ['  1001  ', '1001'],
    ['+55 (11) 5550-0396', '+55 (11) 5550-0396'],
    ['*97', '*97'],
    ['#31#', '#31#'],
    ['0800.123.456', '0800.123.456'],
    ['011-55-1', '011-55-1'],
    ['sip:1001', 'sip:1001'],
    ['xanonymous@host.test', 'xanonymous@host.test'],
    ['anonymous.bob@host.test', 'anonymous.bob@host.test'],
    ['alice@host.invalid.test', 'alice@host.invalid.test'],
    ['alice@invalid.test', 'alice@invalid.test'],
    ['alice@my.invalidhost.test', 'alice@my.invalidhost.test']
  ])('%s', (identity, expected) => {
    expect(redialTarget(identity)).toBe(expected);
  });
});

describe('redialTarget: identities that cannot', () => {
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a display name', 'Alice Smith'],
    ['a single-word display name', 'Alice'],
    ['the anonymous user', 'anonymous@anonymous.invalid'],
    ['anonymous in any case', 'Anonymous@example.com'],
    ['an invalid host', 'caller@host.invalid'],
    ['a bare scheme', 'sip:'],
    ['a scheme with spaces', 'sip:alice smith@x.test'],
    ['a name that starts with a digit but has letters', '3M Support'],
    ['only a plus', '+'],
    ['an address with two ats', 'a@b@c'],
    ['a name with angle brackets', '<sip:1001@x>'],
    ['a lone host', 'pbx.test'],
    ['a name with a number in it', 'Room 1001'],
    ['text before a scheme', 'xsip:1001@h'],
    ['anonymous behind a scheme', 'sip:anonymous@x.test'],
    ['anonymous behind sips', 'sips:Anonymous@x.test'],
    ['an invalid host behind a scheme', 'sips:alice@host.invalid'],
    ['an invalid host with an upper-case suffix', 'alice@HOST.INVALID'],
    ['no user part', '@host.test']
  ])('%s', (_name, identity) => {
    expect(redialTarget(identity)).toBeUndefined();
  });
});

describe('pickRedialAccount', () => {
  it('uses the account the call went through when it is still registered', () => {
    expect(pickRedialAccount('b', ['a', 'b', 'c'])).toBe('b');
  });

  it('falls back to the first registered account when that one is not', () => {
    expect(pickRedialAccount('gone', ['a', 'b'])).toBe('a');
  });

  it('is undefined when no account is registered', () => {
    expect(pickRedialAccount('a', [])).toBeUndefined();
  });
});
