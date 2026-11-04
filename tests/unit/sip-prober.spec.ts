import { describe, expect, it } from 'vitest';
import { NoReachableTransportError } from '../../src/core/sip/transport';
import type { TransportCandidate } from '../../src/core/sip/transport';
import { buildOptionsProbe, buildUpgradeRequest, discoverTransport, expectedAccept, isSipUpgrade } from '../../src/main/sip/prober';
import type { ProbeDeps } from '../../src/main/sip/prober';
import { DEFAULT_USER_AGENT } from '../../src/core/sip';

type SrvAnswer = readonly { name: string; port: number; priority: number; weight: number }[];

interface Fake {
  readonly deps: ProbeDeps;
  readonly probed: string[];
}

const label = (c: TransportCandidate): string => `${c.transport}://${c.host}:${c.port}`;

function fake(options: {
  srv?: Record<string, SrvAnswer | Error>;
  reachable?: readonly string[];
  failWith?: Record<string, Error>;
}): Fake {
  const probed: string[] = [];
  const reachable = new Set(options.reachable ?? []);
  let clock = 0;
  const deps: ProbeDeps = {
    resolveSrv: async (name) => {
      const answer = options.srv?.[name];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    probe: async (candidate) => {
      probed.push(label(candidate));
      if (reachable.has(label(candidate))) return 12;
      throw options.failWith?.[label(candidate)] ?? new Error('ECONNREFUSED');
    },
    now: () => (clock += 5)
  };
  return { deps, probed };
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('discoverTransport', () => {
  it('prefers an SRV-discovered TCP service over defaults', async () => {
    const { deps, probed } = fake({
      srv: { '_sip._tcp.example.com': [{ name: 'pbx.example.com.', port: 5070, priority: 1, weight: 10 }] },
      reachable: ['tcp://pbx.example.com:5070']
    });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(label(result.candidate)).toBe('tcp://pbx.example.com:5070');
    expect(result.candidate.source).toBe('srv');
    expect(probed[probed.length - 1]).toBe('tcp://pbx.example.com:5070');
  });

  it('lets a manual URI win and stops immediately', async () => {
    const { deps, probed } = fake({ reachable: ['tcp://pbx.lan:5060', 'tls://example.com:5061'] });
    const result = await discoverTransport(
      { domain: 'example.com', manualUri: 'tcp://pbx.lan:5060' },
      deps
    );
    expect(result.candidate.source).toBe('manual');
    expect(probed).toEqual(['tcp://pbx.lan:5060']);
    expect(result.outcomes).toHaveLength(1);
  });

  it('probes sequentially in order and never probes after the first success', async () => {
    const { deps, probed } = fake({ reachable: ['tcp://example.com:5060'] });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(probed).toEqual([
      'tls://example.com:5061',
      'wss://example.com:443',
      'tcp://example.com:5060'
    ]);
    expect(result.outcomes.map((o) => o.ok)).toEqual([false, false, true]);
    expect(probed).not.toContain('ws://example.com:80');
    expect(probed).not.toContain('udp://example.com:5060');
  });

  it('survives one DNS name failing while another succeeds', async () => {
    const { deps } = fake({
      srv: {
        '_sips._tcp.example.com': errno('ENOTFOUND'),
        '_sip._tcp.example.com': [{ name: 'sip.example.com', port: 5060, priority: 0, weight: 1 }]
      },
      reachable: ['tcp://sip.example.com:5060']
    });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(label(result.candidate)).toBe('tcp://sip.example.com:5060');
  });

  it.each([
    ['ETIMEDOUT', 'transport.error.timeout'],
    ['ECONNREFUSED', 'transport.error.refused'],
    ['ENOTFOUND', 'transport.error.dns'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'transport.error.tls'],
    ['EWHATEVER', 'transport.error.none-reachable']
  ])('maps %s to %s', async (code, key) => {
    const { deps } = fake({
      reachable: ['udp://example.com:5060'],
      failWith: { 'tls://example.com:5061': errno(code) }
    });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(result.outcomes[0]).toMatchObject({ ok: false, errorKey: key });
  });

  it('maps a timeout message without a code', async () => {
    const { deps } = fake({
      reachable: ['udp://example.com:5060'],
      failWith: { 'tls://example.com:5061': new Error('timeout') }
    });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(result.outcomes[0]).toMatchObject({ errorKey: 'transport.error.timeout' });
  });

  it('records the latency of a successful probe', async () => {
    const { deps } = fake({ reachable: ['tls://example.com:5061'] });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(result.outcomes[0]).toMatchObject({ ok: true, latencyMs: 12 });
  });

  it('passes the configured timeout to every probe', async () => {
    const seen: number[] = [];
    const deps: ProbeDeps = {
      resolveSrv: async () => [],
      probe: async (_candidate, timeoutMs) => {
        seen.push(timeoutMs);
        return 1;
      },
      now: () => 0
    };
    await discoverTransport({ domain: 'example.com' }, deps, { timeoutMs: 777 });
    expect(seen).toEqual([777]);
  });

  it('uses a 2500 ms default timeout', async () => {
    const seen: number[] = [];
    const deps: ProbeDeps = {
      resolveSrv: async () => [],
      probe: async (_candidate, timeoutMs) => {
        seen.push(timeoutMs);
        return 1;
      },
      now: () => 0
    };
    await discoverTransport({ domain: 'example.com' }, deps);
    expect(seen).toEqual([2500]);
  });

  it('raises NoReachableTransportError when nothing answers', async () => {
    const { deps, probed } = fake({});
    await expect(discoverTransport({ domain: 'example.com' }, deps)).rejects.toBeInstanceOf(
      NoReachableTransportError
    );
    expect(probed).toHaveLength(5);
  });
});

describe('WebSocket upgrade verification', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const upgrade = (extra: string[]): string =>
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', ...extra, '', ''].join('\r\n');

  it('computes the RFC 6455 accept value', () => {
    expect(expectedAccept(key)).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('requests the sip subprotocol', () => {
    const request = buildUpgradeRequest('h', 80, key);
    expect(request).toContain('Sec-WebSocket-Protocol: sip');
    expect(request).toContain(`Sec-WebSocket-Key: ${key}`);
    expect(request).toContain('Sec-WebSocket-Version: 13');
  });

  it('accepts a genuine 101 with matching accept and sip protocol', () => {
    const ok = upgrade([`Sec-WebSocket-Accept: ${expectedAccept(key)}`, 'Sec-WebSocket-Protocol: sip']);
    expect(isSipUpgrade(ok, key)).toBe(true);
  });

  it.each([
    ['Apache 403', 'HTTP/1.1 403 Forbidden\r\nServer: Apache/2.4.62\r\n\r\n'],
    ['200', 'HTTP/1.1 200 OK\r\n\r\n'],
    ['redirect', 'HTTP/1.1 301 Moved\r\nLocation: /\r\n\r\n'],
    ['garbage', 'SSH-2.0-OpenSSH\r\n\r\n'],
    ['wrong accept', upgrade(['Sec-WebSocket-Accept: nope', 'Sec-WebSocket-Protocol: sip'])],
    ['no protocol', upgrade([`Sec-WebSocket-Accept: ${expectedAccept(key)}`])],
    ['other protocol', upgrade([`Sec-WebSocket-Accept: ${expectedAccept(key)}`, 'Sec-WebSocket-Protocol: chat'])]
  ])('rejects %s', (_name, response) => {
    expect(isSipUpgrade(response, key)).toBe(false);
  });

  it('an HTTP server on port 80 is not a SIP WebSocket endpoint, so udp is selected', async () => {
    const { deps, probed } = fake({ reachable: ['udp://example.com:5060'] });
    const result = await discoverTransport({ domain: 'example.com' }, deps);
    expect(probed).toContain('ws://example.com:80');
    expect(result.candidate.transport).toBe('udp');
    expect(result.outcomes.find((o) => o.candidate.transport === 'ws')).toMatchObject({ ok: false });
  });
});

describe('buildOptionsProbe (regression: a live Kamailio ignored a probe without rport)', () => {
  const probe = (): string => buildOptionsProbe('pbx.example.com', 55297, 'z9hG4bKabc123');
  const viaLine = (): string =>
    probe()
      .split('\r\n')
      .find((line) => line.startsWith('Via:')) ?? '';

  it('asks the server to answer the source port with rport', () => {
    expect(viaLine()).toContain(';rport');
  });

  it('puts the real local port in sent-by, not a fixed 5060', () => {
    expect(viaLine()).toBe('Via: SIP/2.0/UDP 0.0.0.0:55297;branch=z9hG4bKabc123;rport');
  });

  it('addresses the request to the probed host', () => {
    expect(probe().split('\r\n')[0]).toBe('OPTIONS sip:pbx.example.com SIP/2.0');
  });

  it('does not claim the probed domain as its own identity', () => {
    expect(probe()).toContain('From: <sip:probe@opensip.invalid>;tag=z9hG4bKabc123');
    expect(probe()).not.toContain('probe@pbx.example.com');
  });

  it('declares an empty body and terminates the headers with a blank line', () => {
    expect(probe()).toContain('Content-Length: 0');
    expect(probe().endsWith('\r\n\r\n')).toBe(true);
  });

  it('identifies itself', () => {
    expect(probe()).toContain(`User-Agent: ${DEFAULT_USER_AGENT}`);
  });
});
