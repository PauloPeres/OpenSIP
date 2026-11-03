import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  InvalidDomainError,
  NoReachableTransportError,
  SRV_SERVICES,
  TRANSPORT_ERROR_KEYS,
  TRANSPORT_PREFERENCE,
  UnsupportedTransportError,
  buildCandidates,
  candidateKey,
  candidatesFromSrv,
  defaultCandidates,
  manualCandidate,
  orderCandidates,
  selectBestCandidate,
  srvQueryNames,
  summariseProbe,
  transportLabelKey
} from '../../src/core/sip/transport';
import type {
  CandidateSource,
  ProbeOutcome,
  SipTransport,
  SrvRecord,
  TransportCandidate
} from '../../src/core/sip/transport';

const cand = (
  transport: SipTransport,
  host: string,
  source: CandidateSource,
  srvPriority = 0,
  weight = 0,
  port = 5060
): TransportCandidate => ({ transport, host, port, source, weight, srvPriority });
const ok = (candidate: TransportCandidate, latencyMs: number): ProbeOutcome => ({
  candidate,
  ok: true,
  latencyMs
});
const bad = (candidate: TransportCandidate): ProbeOutcome => ({
  candidate,
  ok: false,
  errorKey: 'transport.error.timeout'
});
const keys = (list: readonly TransportCandidate[]): string[] => list.map(candidateKey);

describe('constants', () => {
  it('prefers encrypted transports, then reliable ones', () => {
    expect(TRANSPORT_PREFERENCE).toEqual(['tls', 'wss', 'tcp', 'ws', 'udp']);
  });

  it('knows the default port of every transport', () => {
    expect(DEFAULT_PORTS).toEqual({ tls: 5061, tcp: 5060, udp: 5060, wss: 443, ws: 80 });
  });

  it('lists the SRV services in preference order', () => {
    expect(SRV_SERVICES).toEqual([
      { service: '_sips._tcp', transport: 'tls' },
      { service: '_sips._wss', transport: 'wss' },
      { service: '_sip._tcp', transport: 'tcp' },
      { service: '_sip._ws', transport: 'ws' },
      { service: '_sip._udp', transport: 'udp' }
    ]);
  });

  it('exposes label and error keys', () => {
    expect(transportLabelKey('tcp')).toBe('transport.tcp');
    expect(transportLabelKey('wss')).toBe('transport.wss');
    expect(TRANSPORT_ERROR_KEYS).toEqual({
      invalidDomain: 'transport.error.invalid-domain',
      unsupported: 'transport.error.unsupported',
      noneReachable: 'transport.error.none-reachable'
    });
  });
});

describe('srvQueryNames', () => {
  it('prefixes the domain with each service in order', () => {
    expect(srvQueryNames('example.com')).toEqual([
      '_sips._tcp.example.com',
      '_sips._wss.example.com',
      '_sip._tcp.example.com',
      '_sip._ws.example.com',
      '_sip._udp.example.com'
    ]);
  });

  it('trims the domain', () => {
    expect(srvQueryNames('  pbx.example.com ')[2]).toBe('_sip._tcp.pbx.example.com');
  });

  it.each(['', '   ', '\t'])('rejects the blank domain %j', (domain) => {
    expect(() => srvQueryNames(domain)).toThrow(InvalidDomainError);
    expect(() => defaultCandidates(domain)).toThrow(InvalidDomainError);
  });
});

describe('candidatesFromSrv', () => {
  it('maps records keeping port, priority and weight', () => {
    const record: SrvRecord = {
      transport: 'tcp',
      name: 'pbx1.example.com',
      port: 5070,
      priority: 10,
      weight: 60
    };
    expect(candidatesFromSrv([record])).toEqual([
      {
        transport: 'tcp',
        host: 'pbx1.example.com',
        port: 5070,
        source: 'srv',
        weight: 60,
        srvPriority: 10
      }
    ]);
  });

  it('strips the trailing dot of fully qualified names only', () => {
    const rec = (name: string): SrvRecord => ({
      transport: 'tcp',
      name,
      port: 1,
      priority: 0,
      weight: 0
    });
    expect(candidatesFromSrv([rec('a.example.com.'), rec('b.example.com')]).map((c) => c.host)).toEqual([
      'a.example.com',
      'b.example.com'
    ]);
  });

  it('returns nothing for no records', () => {
    expect(candidatesFromSrv([])).toEqual([]);
  });
});

describe('defaultCandidates', () => {
  it('guesses one candidate per transport on its default port', () => {
    const list = defaultCandidates(' pbx.example.com ');
    expect(keys(list)).toEqual([
      'tls://pbx.example.com:5061',
      'wss://pbx.example.com:443',
      'tcp://pbx.example.com:5060',
      'ws://pbx.example.com:80',
      'udp://pbx.example.com:5060'
    ]);
    expect(list.every((c) => c.source === 'default' && c.weight === 0 && c.srvPriority === 0)).toBe(
      true
    );
  });
});

describe('manualCandidate', () => {
  it.each([
    ['tcp://pbx:5060', 'tcp', 'pbx', 5060],
    ['tcp://pbx', 'tcp', 'pbx', 5060],
    ['tls://pbx', 'tls', 'pbx', 5061],
    ['TLS://PBX.example.com:5071', 'tls', 'PBX.example.com', 5071],
    ['wss://pbx:8089/ws', 'wss', 'pbx', 8089],
    ['wss://pbx/ws', 'wss', 'pbx', 443],
    ['ws://pbx', 'ws', 'pbx', 80],
    ['udp://pbx:5080', 'udp', 'pbx', 5080],
    ['sip:pbx:5060;transport=tcp', 'tcp', 'pbx', 5060],
    ['sip:pbx;transport=UDP', 'udp', 'pbx', 5060],
    ['sip:alice@pbx:5090;transport=tls', 'tls', 'pbx', 5090],
    ['sip:pbx', 'tcp', 'pbx', 5060],
    ['sips:pbx', 'tls', 'pbx', 5061],
    ['pbx.example.com', 'tcp', 'pbx.example.com', 5060],
    ['pbx.example.com:5070', 'tcp', 'pbx.example.com', 5070],
    ['  pbx.example.com  ', 'tcp', 'pbx.example.com', 5060]
  ] as const)('parses %s', (uri, transport, host, port) => {
    expect(manualCandidate(uri)).toEqual({
      transport,
      host,
      port,
      source: 'manual',
      weight: 0,
      srvPriority: 0
    });
  });

  it.each(['http://pbx', 'ftp://pbx:21'])('rejects the unknown scheme in %s', (uri) => {
    expect(() => manualCandidate(uri)).toThrow(UnsupportedTransportError);
  });

  it('reports the offending value', () => {
    try {
      manualCandidate('sip:pbx;transport=sctp');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedTransportError);
      expect((error as UnsupportedTransportError).value).toBe('sctp');
    }
    try {
      manualCandidate('http://pbx');
      expect.unreachable();
    } catch (error) {
      expect((error as UnsupportedTransportError).value).toBe('http');
    }
  });

  it('rejects an empty host', () => {
    expect(() => manualCandidate('')).toThrow(InvalidDomainError);
    expect(() => manualCandidate('tcp://')).toThrow(InvalidDomainError);
  });
});

describe('candidateKey', () => {
  it('lowercases transport, host and port', () => {
    expect(candidateKey(cand('tcp', 'PBX.Example.COM', 'srv', 0, 0, 5060))).toBe(
      'tcp://pbx.example.com:5060'
    );
  });
});

describe('orderCandidates', () => {
  it('puts manual before srv before default regardless of transport', () => {
    const list = [
      cand('tls', 'd', 'default'),
      cand('udp', 's', 'srv'),
      cand('udp', 'm', 'manual')
    ];
    expect(orderCandidates(list).map((c) => c.source)).toEqual(['manual', 'srv', 'default']);
  });

  it('sorts SRV priority ASCENDING', () => {
    const list = [cand('tcp', 'b', 'srv', 20), cand('tcp', 'a', 'srv', 10), cand('tcp', 'c', 'srv', 30)];
    expect(orderCandidates(list).map((c) => c.srvPriority)).toEqual([10, 20, 30]);
  });

  it('sorts SRV weight DESCENDING within a priority', () => {
    const list = [
      cand('tcp', 'a', 'srv', 10, 5),
      cand('tcp', 'b', 'srv', 10, 90),
      cand('tcp', 'c', 'srv', 10, 40)
    ];
    expect(orderCandidates(list).map((c) => c.weight)).toEqual([90, 40, 5]);
  });

  it('lets priority beat weight', () => {
    const list = [cand('tcp', 'heavy', 'srv', 20, 100), cand('tcp', 'light', 'srv', 10, 1)];
    expect(orderCandidates(list).map((c) => c.host)).toEqual(['light', 'heavy']);
  });

  it('lets SRV priority beat transport preference', () => {
    const list = [cand('tls', 'a', 'srv', 20), cand('udp', 'b', 'srv', 10)];
    expect(orderCandidates(list).map((c) => c.transport)).toEqual(['udp', 'tls']);
  });

  it('ignores priority and weight for non-SRV sources', () => {
    const list = [cand('udp', 'a', 'default', 0, 0), cand('tls', 'b', 'default', 9, 0)];
    expect(orderCandidates(list).map((c) => c.transport)).toEqual(['tls', 'udp']);
    const heavy = [cand('udp', 'a', 'manual', 0, 0), cand('tls', 'b', 'manual', 0, 99)];
    expect(orderCandidates(heavy).map((c) => c.transport)).toEqual(['tls', 'udp']);
  });

  it('falls back to transport preference order', () => {
    const list = [...TRANSPORT_PREFERENCE].reverse().map((t) => cand(t, 'h', 'default'));
    expect(orderCandidates(list).map((c) => c.transport)).toEqual([...TRANSPORT_PREFERENCE]);
  });

  it('breaks the remaining ties by key ascending', () => {
    const list = [cand('tcp', 'zeta', 'srv'), cand('tcp', 'alpha', 'srv'), cand('tcp', 'mid', 'srv')];
    expect(orderCandidates(list).map((c) => c.host)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('de-duplicates by key keeping the best-ranked occurrence', () => {
    const list = [
      cand('tcp', 'PBX', 'default'),
      cand('tcp', 'pbx', 'srv', 10, 5),
      cand('tcp', 'pbx', 'manual')
    ];
    const ordered = orderCandidates(list);
    expect(ordered).toHaveLength(1);
    expect(ordered[0]?.source).toBe('manual');
  });

  it('is deterministic and does not mutate its input', () => {
    const list = [cand('udp', 'b', 'default'), cand('tls', 'a', 'srv', 1, 2), cand('tcp', 'c', 'manual')];
    const snapshot = [...list];
    const first = orderCandidates(list);
    expect(list).toEqual(snapshot);
    expect(orderCandidates([...list].reverse())).toEqual(first);
    expect(orderCandidates(first)).toEqual(first);
  });
});

describe('buildCandidates', () => {
  const srv: SrvRecord[] = [
    { transport: 'tcp', name: 'pbx1.example.com.', port: 5060, priority: 10, weight: 50 }
  ];

  it('falls back to the default ladder with no manual URI and no SRV', () => {
    expect(keys(buildCandidates({ domain: 'example.com' }))).toEqual(
      keys(defaultCandidates('example.com'))
    );
  });

  it('ranks SRV before guessed defaults', () => {
    const list = buildCandidates({ domain: 'example.com', srvRecords: srv });
    expect(list[0]).toMatchObject({ source: 'srv', host: 'pbx1.example.com', transport: 'tcp' });
    expect(list).toHaveLength(6);
    expect(list.slice(1).every((c) => c.source === 'default')).toBe(true);
  });

  it('ranks a manual URI before everything', () => {
    const list = buildCandidates({
      domain: 'example.com',
      srvRecords: srv,
      manualUri: 'udp://other:5080'
    });
    expect(list[0]).toMatchObject({ source: 'manual', transport: 'udp', host: 'other' });
    expect(list[1]?.source).toBe('srv');
  });

  it('collapses a manual URI equal to a default guess', () => {
    const list = buildCandidates({ domain: 'example.com', manualUri: 'tcp://example.com:5060' });
    expect(list).toHaveLength(5);
    expect(list[0]?.source).toBe('manual');
  });
});

describe('selectBestCandidate', () => {
  const tls = cand('tls', 'h', 'default', 0, 0, 5061);
  const tcp = cand('tcp', 'h', 'default');
  const udp = cand('udp', 'h', 'default');
  const srvTcp = cand('tcp', 'srv', 'srv', 10, 5);

  it('picks the best-ordered reachable candidate, not the fastest', () => {
    expect(selectBestCandidate([ok(udp, 1), ok(tcp, 90), ok(tls, 400)])).toBe(tls);
  });

  it('ignores failed outcomes', () => {
    expect(selectBestCandidate([bad(tls), ok(udp, 300), bad(tcp)])).toBe(udp);
  });

  it('prefers SRV over default even when slower', () => {
    expect(selectBestCandidate([ok(tls, 1), ok(srvTcp, 999)])).toBe(srvTcp);
  });

  it('picks the lower latency among identical candidates', () => {
    const slow = ok(tcp, 80);
    const fast = ok({ ...tcp }, 20);
    expect(selectBestCandidate([slow, fast])).toBe(fast.candidate);
    expect(selectBestCandidate([fast, slow])).toBe(fast.candidate);
  });

  it('does not mutate the outcomes', () => {
    const outcomes = [ok(udp, 1), ok(tls, 2)];
    selectBestCandidate(outcomes);
    expect(outcomes.map((o) => o.candidate)).toEqual([udp, tls]);
  });

  it('throws when nothing is reachable', () => {
    expect(() => selectBestCandidate([bad(tls), bad(tcp)])).toThrow(NoReachableTransportError);
    expect(() => selectBestCandidate([])).toThrow(NoReachableTransportError);
  });
});

describe('summariseProbe', () => {
  it('counts reachable and failed outcomes and names the best', () => {
    const tcp = cand('tcp', 'h', 'default');
    const udp = cand('udp', 'h', 'default');
    expect(summariseProbe([ok(udp, 5), bad(cand('tls', 'h', 'default')), ok(tcp, 9)])).toEqual({
      reachable: 2,
      failed: 1,
      best: tcp
    });
  });

  it('has no best when everything failed', () => {
    expect(summariseProbe([bad(cand('tls', 'h', 'default'))])).toEqual({
      reachable: 0,
      failed: 1,
      best: undefined
    });
    expect(summariseProbe([])).toEqual({ reachable: 0, failed: 0, best: undefined });
  });
});

describe('errors', () => {
  it('carry stable names and messages', () => {
    expect(new InvalidDomainError()).toMatchObject({ name: 'InvalidDomainError', message: 'invalid-domain' });
    expect(new NoReachableTransportError()).toMatchObject({
      name: 'NoReachableTransportError',
      message: 'no-reachable-transport'
    });
    expect(new UnsupportedTransportError('x')).toMatchObject({
      name: 'UnsupportedTransportError',
      message: 'unsupported-transport',
      value: 'x'
    });
  });
});
