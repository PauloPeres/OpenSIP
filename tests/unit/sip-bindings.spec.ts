import { describe, expect, it } from 'vitest';
import { analyseBindings, isOurBinding, otherBindings, parseContactBindings } from '@core/sip';

const OURS = { host: '203.0.113.91', port: 59109, user: '5550000068' };
const observed =
  '<sip:5550000068@203.0.113.91:59109;transport=udp>;expires=600;received="sip:203.0.113.91:59109"';
const elsewhere = '<sip:5550000068@203.0.113.7:5070;transport=udp>;expires=300';

describe('parseContactBindings', () => {
  it('parses the shape observed from the live server', () => {
    expect(parseContactBindings([observed])).toEqual([
      { uri: 'sip:5550000068@203.0.113.91:59109', expires: 600, raw: observed }
    ]);
  });

  it('returns nothing for no headers and for blank ones', () => {
    expect(parseContactBindings([])).toEqual([]);
    expect(parseContactBindings(['', '  '])).toEqual([]);
  });

  it('splits several comma-separated contacts in one header value', () => {
    const bindings = parseContactBindings([`${observed}, ${elsewhere}`]);
    expect(bindings.map((b) => b.uri)).toEqual([
      'sip:5550000068@203.0.113.91:59109',
      'sip:5550000068@203.0.113.7:5070'
    ]);
    expect(bindings.map((b) => b.expires)).toEqual([600, 300]);
    expect(bindings[1]?.raw).toBe(elsewhere);
  });

  it('collects contacts split across several headers', () => {
    expect(parseContactBindings([observed, elsewhere])).toHaveLength(2);
  });

  it('does not split on a comma inside a quoted display name', () => {
    const bindings = parseContactBindings(['"Silva, Ana" <sip:ana@host.test:5060>;expires=60']);
    expect(bindings).toEqual([
      { uri: 'sip:ana@host.test:5060', expires: 60, raw: '"Silva, Ana" <sip:ana@host.test:5060>;expires=60' }
    ]);
  });

  it('does not split on a comma inside a quoted parameter', () => {
    const value = '<sip:a@h.test>;+sip.instance="<urn:a,b>";expires=30, <sip:b@h.test>';
    expect(parseContactBindings([value]).map((b) => b.uri)).toEqual(['sip:a@h.test:5060', 'sip:b@h.test:5060']);
  });

  it('honours an escaped quote inside a quoted display name', () => {
    const value = '"Say \\"hi, there\\"" <sip:a@h.test>, <sip:b@h.test>';
    expect(parseContactBindings([value])).toHaveLength(2);
  });

  it('keeps a backslash-escaped comma inside a quoted display name', () => {
    const bindings = parseContactBindings(['"a\\,b" <sip:a@h.test>, <sip:b@h.test>']);
    expect(bindings.map((b) => b.uri)).toEqual(['sip:a@h.test:5060', 'sip:b@h.test:5060']);
  });

  it('does not split on a comma inside the angle brackets', () => {
    expect(parseContactBindings(['<sip:a@h.test;x=1,2>, <sip:b@h.test>'])).toHaveLength(2);
  });

  it('lowercases the host, keeps the user as written and defaults the port', () => {
    expect(parseContactBindings(['<sip:Bob@PBX.Test>'])[0]?.uri).toBe('sip:Bob@pbx.test:5060');
    expect(parseContactBindings(['<sips:Bob@PBX.Test>'])[0]?.uri).toBe('sips:Bob@pbx.test:5061');
  });

  it('strips URI parameters from the normalised uri', () => {
    expect(parseContactBindings(['<sip:u@h.test:5080;transport=tcp;ob>'])[0]?.uri).toBe('sip:u@h.test:5080');
  });

  it('reads an address without angle brackets, whose parameters belong to the header', () => {
    expect(parseContactBindings(['sip:u@h.test:5080;expires=45'])).toEqual([
      { uri: 'sip:u@h.test:5080', expires: 45, raw: 'sip:u@h.test:5080;expires=45' }
    ]);
    expect(parseContactBindings(['sip:u@h.test'])[0]?.uri).toBe('sip:u@h.test:5060');
  });

  it('reads expires case-insensitively and with spaces or quotes', () => {
    expect(parseContactBindings(['<sip:u@h.test>; Expires = 12'])[0]?.expires).toBe(12);
    expect(parseContactBindings(['<sip:u@h.test>;expires="70"'])[0]?.expires).toBe(70);
    expect(parseContactBindings(['<sip:u@h.test>;expires=0'])[0]?.expires).toBe(0);
  });

  it('leaves expires undefined when absent or not a number, and ignores one inside a quoted value', () => {
    expect(parseContactBindings(['<sip:u@h.test>'])[0]).not.toHaveProperty('expires');
    expect(parseContactBindings(['<sip:u@h.test>;expires=soon'])[0]).not.toHaveProperty('expires');
    expect(parseContactBindings(['<sip:u@h.test>;note="x;expires=9"'])[0]).not.toHaveProperty('expires');
    expect(parseContactBindings(['<sip:u@h.test;expires=9>'])[0]).not.toHaveProperty('expires');
  });

  it('reads an unquoted display name', () => {
    expect(parseContactBindings(['Bob <sip:bob@h.test>;expires=5'])).toEqual([
      { uri: 'sip:bob@h.test:5060', expires: 5, raw: 'Bob <sip:bob@h.test>;expires=5' }
    ]);
  });

  it('rejects a contact whose display name is neither a token nor a quoted string', () => {
    expect(parseContactBindings(['Bob "x" <sip:bob@h.test>'])).toEqual([]);
  });

  it('trims the contact and the uri, and ignores empty pieces between commas', () => {
    const bindings = parseContactBindings(['  < sip:a@h.test >  ,, <sip:b@h.test> ,']);
    expect(bindings.map((b) => b.raw)).toEqual(['< sip:a@h.test >', '<sip:b@h.test>']);
    expect(bindings.map((b) => b.uri)).toEqual(['sip:a@h.test:5060', 'sip:b@h.test:5060']);
  });

  it('finds expires after other parameters, and ignores a lookalike parameter name', () => {
    expect(parseContactBindings(['<sip:u@h.test>;q=0.5;transport=udp;expires=30'])[0]?.expires).toBe(30);
    expect(parseContactBindings(['<sip:u@h.test>;xexpires=30;expires=31'])[0]?.expires).toBe(31);
    expect(parseContactBindings(['<sip:u@h.test>;expires=30x'])[0]).not.toHaveProperty('expires');
    expect(parseContactBindings(['<sip:u@h.test>;expires=x30'])[0]).not.toHaveProperty('expires');
    expect(parseContactBindings(['<sip:u@h.test>;expires="30'])[0]).not.toHaveProperty('expires');
  });

  it('does not let a quote inside angle brackets swallow the following comma', () => {
    expect(parseContactBindings(['<sip:a@h.test;x=">, <sip:b@h.test>'])).toHaveLength(2);
  });

  it('skips the wildcard and anything that is not a SIP uri', () => {
    expect(parseContactBindings(['*'])).toEqual([]);
    expect(parseContactBindings(['<tel:+5511999>'])).toEqual([]);
    expect(parseContactBindings(['<sip:@>', 'garbage', '<sip:u@h.test:99999>'])).toEqual([]);
    expect(parseContactBindings(['<sip:u@h.test>, *'])).toHaveLength(1);
  });

  it('reads a uri with no user part', () => {
    expect(parseContactBindings(['<sip:h.test:5070>'])[0]?.uri).toBe('sip:h.test:5070');
  });
});

describe('isOurBinding', () => {
  const binding = (uri: string): Parameters<typeof isOurBinding>[0] => ({ uri, raw: uri });

  it('matches on user, host and port', () => {
    expect(isOurBinding(binding('sip:5550000068@203.0.113.91:59109'), OURS)).toBe(true);
  });

  it('compares the host case-insensitively but the user exactly', () => {
    const ours = { host: 'PBX.Test', port: 5060, user: 'Bob' };
    expect(isOurBinding(binding('sip:Bob@pbx.test:5060'), ours)).toBe(true);
    expect(isOurBinding(binding('sip:bob@pbx.test:5060'), ours)).toBe(false);
  });

  it.each([
    ['user', 'sip:other@203.0.113.91:59109'],
    ['host', 'sip:5550000068@189.1.153.92:59109'],
    ['port', 'sip:5550000068@203.0.113.91:59110']
  ])('does not match a different %s', (_name, uri) => {
    expect(isOurBinding(binding(uri), OURS)).toBe(false);
  });

  it('never matches an unparseable uri', () => {
    expect(isOurBinding(binding('nonsense'), OURS)).toBe(false);
  });
});

describe('analyseBindings', () => {
  it('reports one binding that is ours as not shared and not displaced', () => {
    expect(analyseBindings([observed], OURS)).toEqual({ others: 0, displaced: false });
  });

  it('must NOT call an empty list a displacement', () => {
    expect(analyseBindings([], OURS)).toEqual({ others: 0, displaced: false });
    expect(analyseBindings(['', ' '], OURS)).toEqual({ others: 0, displaced: false });
  });

  it('counts a second device while we are still bound', () => {
    expect(analyseBindings([observed, elsewhere], OURS)).toEqual({ others: 1, displaced: false });
  });

  it('counts contacts from one header value and from several headers alike', () => {
    expect(analyseBindings([`${observed}, ${elsewhere}`], OURS)).toEqual({ others: 1, displaced: false });
    const third = '<sip:5550000068@198.51.100.2:5060>;expires=60';
    expect(analyseBindings([observed, elsewhere, third], OURS)).toEqual({ others: 2, displaced: false });
  });

  it('is displaced when there are bindings and none is ours', () => {
    expect(analyseBindings([elsewhere], OURS)).toEqual({ others: 1, displaced: true });
    expect(analyseBindings([elsewhere, '<sip:5550000068@198.51.100.2>'], OURS)).toEqual({ others: 2, displaced: true });
  });

  it('treats a differing port as a different device', () => {
    const samePortless = '<sip:5550000068@203.0.113.91:59110>;expires=600';
    expect(analyseBindings([samePortless], OURS)).toEqual({ others: 1, displaced: true });
  });

  it('ignores the transport parameter when matching', () => {
    const tcp = '<sip:5550000068@203.0.113.91:59109;transport=tcp>;expires=600';
    expect(analyseBindings([tcp], OURS)).toEqual({ others: 0, displaced: false });
  });

  it('does not count a binding that is being removed', () => {
    const removing = '<sip:5550000068@203.0.113.7:5070>;expires=0';
    expect(analyseBindings([observed, removing], OURS)).toEqual({ others: 0, displaced: false });
    expect(analyseBindings([removing], OURS)).toEqual({ others: 0, displaced: false });
  });

  it('does not count our own removal as being present', () => {
    const goneOurs = '<sip:5550000068@203.0.113.91:59109>;expires=0';
    expect(analyseBindings([goneOurs, elsewhere], OURS)).toEqual({ others: 1, displaced: true });
  });

  it('counts a binding with expires of 1 and one with no expires', () => {
    expect(analyseBindings(['<sip:5550000068@203.0.113.7>;expires=1'], OURS).others).toBe(1);
    expect(analyseBindings(['<sip:5550000068@203.0.113.7>'], OURS).others).toBe(1);
  });
});

describe('otherBindings', () => {
  it('lists only live bindings that are not ours', () => {
    const removing = '<sip:5550000068@198.51.100.9>;expires=0';
    expect(otherBindings([observed, elsewhere, removing], OURS).map((b) => b.uri)).toEqual([
      'sip:5550000068@203.0.113.7:5070'
    ]);
  });
});
