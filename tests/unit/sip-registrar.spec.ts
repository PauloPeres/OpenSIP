import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorization, createAccount, parseChallenge, serialize } from '../../src/core/sip';
import type { SipAccount, SipMessage, SipRequest, SipResponse, TransportCandidate } from '../../src/core/sip';
import type { IdFactory } from '../../src/main/sip/ids';
import { MAX_AUTH_ATTEMPTS, buildRegisterRequest, register } from '../../src/main/sip/registrar';
import type { RegisterParams } from '../../src/main/sip/registrar';
import type { SipConnection } from '../../src/main/sip/connection';

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

const account: SipAccount = createAccount(
  { displayName: 'Jane', username: '1001', password: 'secret', domain: 'pbx.example.com' },
  'acc-1'
);

const candidate = (transport: TransportCandidate['transport'] = 'tcp'): TransportCandidate => ({
  transport,
  host: 'pbx.example.com',
  port: 5060,
  source: 'srv',
  weight: 0,
  srvPriority: 0
});

const params = (transport: TransportCandidate['transport'] = 'tcp', expires = 600): RegisterParams => ({
  account,
  candidate: candidate(transport),
  expires,
  localAddress: { host: '10.0.0.5', port: 51234 }
});

function sequentialIds(): IdFactory {
  const counter = { branch: 0, tag: 0, call: 0, nonce: 0 };
  return {
    newBranch: () => `z9hG4bKbranch${++counter.branch}`,
    newTag: () => `tag${++counter.tag}`,
    newCallId: (host) => `call${++counter.call}@${host}`,
    newCnonce: () => `cnonce${++counter.nonce}`
  };
}

const CHALLENGE = 'Digest realm="asterisk", nonce="abc123", algorithm=MD5, qop="auth"';

function reply(request: SipRequest, status: number, extra: Record<string, string[]> = {}): SipResponse {
  return {
    kind: 'response',
    status,
    reason: 'X',
    headers: {
      'call-id': request.headers['call-id'] ?? [],
      cseq: request.headers['cseq'] ?? [],
      ...extra
    },
    body: ''
  };
}

interface FakeConnection extends SipConnection {
  readonly sent: SipRequest[];
}

function fakeConnection(
  responder: (request: SipRequest, n: number) => SipResponse | undefined,
  transport: TransportCandidate['transport'] = 'tcp'
): FakeConnection {
  const listeners = new Set<(message: SipMessage) => void>();
  const sent: SipRequest[] = [];
  return {
    sent,
    candidate: candidate(transport),
    localAddress: { host: '10.0.0.5', port: 51234 },
    send: async (message) => {
      sent.push(message as SipRequest);
      const response = responder(message as SipRequest, sent.length);
      if (response !== undefined) queueMicrotask(() => listeners.forEach((l) => l(response)));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
    close: () => undefined
  };
}

describe('buildRegisterRequest', () => {
  it('serialises to the exact expected bytes', () => {
    const request = buildRegisterRequest(params(), sequentialIds(), 1);
    expect(serialize(request)).toBe(
      [
        'REGISTER sip:pbx.example.com SIP/2.0',
        'Via: SIP/2.0/TCP 10.0.0.5:51234;branch=z9hG4bKbranch1;rport',
        'Max-Forwards: 70',
        'From: <sip:1001@pbx.example.com>;tag=tag1',
        'To: <sip:1001@pbx.example.com>',
        'Call-ID: call1@10.0.0.5',
        'CSeq: 1 REGISTER',
        'Contact: <sip:1001@10.0.0.5:51234;transport=tcp>',
        'Expires: 600',
        'User-Agent: OpenSIP/0.1.0',
        'Allow: INVITE, ACK, CANCEL, BYE, OPTIONS',
        'Content-Length: 0',
        '',
        ''
      ].join('\r\n')
    );
  });

  it('has an empty body and no authorization by default', () => {
    const request = buildRegisterRequest(params(), sequentialIds(), 1);
    expect(request.body).toBe('');
    expect(request.headers['authorization']).toBeUndefined();
    expect(request.method).toBe('REGISTER');
    expect(request.uri).toBe('sip:pbx.example.com');
  });

  it.each([
    ['tcp', 'TCP'],
    ['tls', 'TLS'],
    ['udp', 'UDP'],
    ['ws', 'WS'],
    ['wss', 'WSS']
  ] as const)('uses %s in Via and the Contact transport parameter', (transport, via) => {
    const request = buildRegisterRequest(params(transport), sequentialIds(), 1);
    expect(request.headers['via']?.[0]).toContain(`SIP/2.0/${via} `);
    expect(request.headers['contact']?.[0]).toContain(`;transport=${transport}>`);
  });

  it('honours cseq and expires', () => {
    const request = buildRegisterRequest(params('tcp', 120), sequentialIds(), 7);
    expect(request.headers['cseq']).toEqual(['7 REGISTER']);
    expect(request.headers['expires']).toEqual(['120']);
  });

  it('reuses a supplied Call-ID and From tag', () => {
    const request = buildRegisterRequest({ ...params(), callId: 'fixed@x', fromTag: 'ft' }, sequentialIds(), 2);
    expect(request.headers['call-id']).toEqual(['fixed@x']);
    expect(request.headers['from']?.[0]).toBe('<sip:1001@pbx.example.com>;tag=ft');
  });

  it('adds Authorization by default and Proxy-Authorization on request', () => {
    const plain = buildRegisterRequest(params(), sequentialIds(), 2, 'Digest x');
    expect(plain.headers['authorization']).toEqual(['Digest x']);
    const proxy = buildRegisterRequest(params(), sequentialIds(), 2, 'Digest x', 'proxy-authorization');
    expect(proxy.headers['proxy-authorization']).toEqual(['Digest x']);
    expect(proxy.headers['authorization']).toBeUndefined();
  });

  it('falls back to the candidate address without a local address', () => {
    const rest: RegisterParams = { ...params() };
    delete (rest as { localAddress?: unknown }).localAddress;
    const request = buildRegisterRequest(rest, sequentialIds(), 1);
    expect(request.headers['contact']?.[0]).toBe('<sip:1001@pbx.example.com:5060;transport=tcp>');
  });
});

describe('register', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = (connection: SipConnection, timeoutMs?: number) =>
    register(params(), {
      connection,
      ids: sequentialIds(),
      hash: md5,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });

  it('succeeds on 200 and reports the Expires header', async () => {
    const connection = fakeConnection((request) => reply(request, 200, { expires: ['300'] }));
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 300 });
    expect(connection.sent).toHaveLength(1);
  });

  it('falls back to the Contact expires parameter', async () => {
    const connection = fakeConnection((request) =>
      reply(request, 200, { contact: ['<sip:1001@10.0.0.5:51234>;expires=240'] })
    );
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 240 });
  });

  it('falls back to the requested expiry', async () => {
    const connection = fakeConnection((request) => reply(request, 200));
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 600 });
  });

  it('ignores a non-numeric Expires and a Contact without expires', async () => {
    const connection = fakeConnection((request) =>
      reply(request, 200, { expires: ['soon'], contact: ['<sip:1001@10.0.0.5>'] })
    );
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 600 });
  });

  it('answers a 401 challenge with the right credentials and a bumped CSeq', async () => {
    const connection = fakeConnection((request, n) =>
      n === 1 ? reply(request, 401, { 'www-authenticate': [CHALLENGE] }) : reply(request, 200)
    );
    const result = await run(connection);
    expect(result).toEqual({ ok: true, expiresIn: 600 });
    const [first, second] = connection.sent;
    expect(first?.headers['cseq']).toEqual(['1 REGISTER']);
    expect(second?.headers['cseq']).toEqual(['2 REGISTER']);
    expect(second?.headers['call-id']).toEqual(first?.headers['call-id']);
    expect(second?.headers['from']).toEqual(first?.headers['from']);
    expect(second?.headers['via']).not.toEqual(first?.headers['via']);
    const expected = buildAuthorization({
      challenge: parseChallenge(CHALLENGE),
      username: '1001',
      password: 'secret',
      method: 'REGISTER',
      digestUri: 'sip:pbx.example.com',
      nonceCount: 1,
      cnonce: 'cnonce1',
      hash: md5
    });
    expect(second?.headers['authorization']).toEqual([expected]);
  });

  it('uses Proxy-Authorization for a 407', async () => {
    const connection = fakeConnection((request, n) =>
      n === 1 ? reply(request, 407, { 'proxy-authenticate': [CHALLENGE] }) : reply(request, 200)
    );
    await expect(run(connection)).resolves.toMatchObject({ ok: true });
    expect(connection.sent[1]?.headers['proxy-authorization']?.[0]).toMatch(/^Digest username="1001"/);
    expect(connection.sent[1]?.headers['authorization']).toBeUndefined();
  });

  const challengeWith = (nonce: string, extra = ''): string =>
    `Digest realm="asterisk", nonce="${nonce}", algorithm=MD5, qop="auth"${extra}`;
  const nonceOf = (request: SipRequest): string | undefined =>
    /nonce="([^"]*)"/.exec(request.headers['authorization']?.[0] ?? '')?.[1];

  it('retries a second challenge that carries a new nonce and registers (live Kamailio trace)', async () => {
    const connection = fakeConnection((request, n) =>
      n < 3 ? reply(request, 401, { 'www-authenticate': [challengeWith(`nonce${n}`)] }) : reply(request, 200)
    );
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 600 });
    expect(connection.sent.map((r) => r.headers['cseq']?.[0])).toEqual([
      '1 REGISTER',
      '2 REGISTER',
      '3 REGISTER'
    ]);
    expect(nonceOf(connection.sent[1] as SipRequest)).toBe('nonce1');
    expect(nonceOf(connection.sent[2] as SipRequest)).toBe('nonce2');
    const [a, b, c] = connection.sent;
    expect(new Set([a, b, c].map((r) => r?.headers['call-id']?.[0])).size).toBe(1);
    expect(new Set([a, b, c].map((r) => r?.headers['from']?.[0])).size).toBe(1);
    const cnonces = [b, c].map((r) => /cnonce="([^"]*)"/.exec(r?.headers['authorization']?.[0] ?? '')?.[1]);
    expect(new Set(cnonces).size).toBe(2);
    expect(c?.headers['authorization']?.[0]).toContain('nc=00000001');
  });

  it('stops immediately when the same nonce is challenged twice (wrong password)', async () => {
    const connection = fakeConnection((request) => reply(request, 401, { 'www-authenticate': [CHALLENGE] }));
    await expect(run(connection)).resolves.toEqual({
      ok: false,
      status: 401,
      errorKey: 'registration.error.unauthorized'
    });
    expect(connection.sent).toHaveLength(2);
  });

  it('gives up with unauthorized after MAX_AUTH_ATTEMPTS ever-changing nonces', async () => {
    const connection = fakeConnection((request, n) =>
      reply(request, 401, { 'www-authenticate': [challengeWith(`n${n}`)] })
    );
    await expect(run(connection)).resolves.toEqual({
      ok: false,
      status: 401,
      errorKey: 'registration.error.unauthorized'
    });
    expect(connection.sent).toHaveLength(1 + MAX_AUTH_ATTEMPTS);
  });

  it('always retries a stale=true challenge, even with a repeated nonce', async () => {
    const connection = fakeConnection((request, n) => {
      const extra = n === 2 ? ', stale=true' : '';
      return n < 3 ? reply(request, 401, { 'www-authenticate': [challengeWith('same', extra)] }) : reply(request, 200);
    });
    await expect(run(connection)).resolves.toMatchObject({ ok: true });
    expect(connection.sent).toHaveLength(3);
  });

  it.each([
    ['missing', {}],
    ['malformed', { 'www-authenticate': ['Basic realm="x"'] }],
    ['unsupported', { 'www-authenticate': ['Digest realm="x", nonce="n", algorithm=SHA-256'] }]
  ])('rejects a 401 with a %s challenge without retrying', async (_name, headers) => {
    const connection = fakeConnection((request) => reply(request, 401, headers));
    await expect(run(connection)).resolves.toEqual({
      ok: false,
      status: 401,
      errorKey: 'registration.error.rejected'
    });
    expect(connection.sent).toHaveLength(1);
  });

  it.each([
    [403, 'registration.error.forbidden'],
    [404, 'registration.error.notFound'],
    [408, 'registration.error.timeout'],
    [500, 'registration.error.rejected'],
    [423, 'registration.error.rejected']
  ])('maps status %i to %s', async (status, errorKey) => {
    const connection = fakeConnection((request) => reply(request, status));
    await expect(run(connection)).resolves.toEqual({ ok: false, status, errorKey });
  });

  it('ignores provisional responses and unrelated messages', async () => {
    const listeners = new Set<(message: SipMessage) => void>();
    const connection: SipConnection = {
      ...fakeConnection(() => undefined),
      send: async (message) => {
        const request = message as SipRequest;
        const other = { ...reply(request, 200), headers: { 'call-id': ['other'], cseq: ['1 REGISTER'] } };
        const wrongMethod = { ...reply(request, 200), headers: { ...reply(request, 200).headers, cseq: ['1 INVITE'] } };
        queueMicrotask(() => {
          for (const m of [reply(request, 100), other, wrongMethod, request, reply(request, 200)]) {
            listeners.forEach((l) => l(m));
          }
        });
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    await expect(run(connection)).resolves.toEqual({ ok: true, expiresIn: 600 });
    expect(listeners.size).toBe(0);
  });

  it('times out when no response arrives', async () => {
    const connection = fakeConnection(() => undefined);
    const pending = run(connection, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({
      ok: false,
      status: 408,
      errorKey: 'registration.error.timeout'
    });
  });

  it('times out when the send itself fails', async () => {
    const connection: SipConnection = {
      ...fakeConnection(() => undefined),
      send: async () => {
        throw new Error('socket closed');
      }
    };
    await expect(run(connection)).resolves.toEqual({
      ok: false,
      status: 408,
      errorKey: 'registration.error.timeout'
    });
  });

  describe('NAT traversal', () => {
    const natVia = 'SIP/2.0/TCP 10.0.0.5:51234;branch=z9hG4bKbranch1;received=203.0.113.91;rport=61878';

    it('uses received/rport from a 401 for the next Contact, keeping Via on the local address', async () => {
      const connection = fakeConnection((request, n) =>
        n === 1
          ? reply(request, 401, { via: [natVia], 'www-authenticate': [CHALLENGE] })
          : reply(request, 200)
      );
      await run(connection);
      expect(connection.sent[0]?.headers['contact']).toEqual(['<sip:1001@10.0.0.5:51234;transport=tcp>']);
      expect(connection.sent[1]?.headers['contact']).toEqual(['<sip:1001@203.0.113.91:61878;transport=tcp>']);
      expect(connection.sent[1]?.headers['via']?.[0]).toContain('SIP/2.0/TCP 10.0.0.5:51234;');
      expect(connection.publicAddress).toEqual({ host: '203.0.113.91', port: 61878 });
    });

    it('learns the address from a 200 and uses it for a later registration', async () => {
      const connection = fakeConnection((request) => reply(request, 200, { via: [natVia] }));
      await run(connection);
      await run(connection);
      expect(connection.sent[1]?.headers['contact']?.[0]).toContain('@203.0.113.91:61878;');
    });

    it('keeps the local port when only received is present', async () => {
      const connection = fakeConnection((request) =>
        reply(request, 200, { via: ['SIP/2.0/TCP 10.0.0.5:51234;received=203.0.113.91'] })
      );
      await run(connection);
      expect(connection.publicAddress).toEqual({ host: '203.0.113.91', port: 51234 });
    });

    it('learns nothing without received or without a Via', async () => {
      const connection = fakeConnection((request) =>
        reply(request, 200, { via: ['SIP/2.0/TCP 10.0.0.5:51234;rport=1'] })
      );
      await run(connection);
      expect(connection.publicAddress).toBeUndefined();
      const bare = fakeConnection((request) => reply(request, 200));
      await run(bare);
      expect(bare.publicAddress).toBeUndefined();
    });
  });

  describe('UDP retransmission', () => {
    it('resends on timer A (500 ms doubling) for 7 transmissions then times out at 32 s', async () => {
      const stamps: number[] = [];
      const connection = fakeConnection(() => {
        stamps.push(Date.now());
        return undefined;
      }, 'udp');
      const start = Date.now();
      const pending = register(
        { ...params('udp') },
        { connection, ids: sequentialIds(), hash: md5 }
      );
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(pending).resolves.toEqual({
        ok: false,
        status: 408,
        errorKey: 'registration.error.timeout'
      });
      expect(stamps.map((t) => t - start)).toEqual([0, 500, 1500, 3500, 7500, 15500, 31500]);
      const bytes = new Set(connection.sent.map((r) => serialize(r)));
      expect(bytes.size).toBe(1);
    });

    it('stops retransmitting once a response arrives', async () => {
      let count = 0;
      const connection = fakeConnection((request) => {
        count += 1;
        return count === 3 ? reply(request, 200) : undefined;
      }, 'udp');
      const pending = register(params('udp'), { connection, ids: sequentialIds(), hash: md5 });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(40_000);
      expect(count).toBe(3);
    });

    it('does not retransmit over a reliable transport', async () => {
      const connection = fakeConnection(() => undefined, 'tcp');
      const pending = register(params('tcp'), { connection, ids: sequentialIds(), hash: md5 });
      await vi.advanceTimersByTimeAsync(11_000);
      await pending;
      expect(connection.sent).toHaveLength(1);
    });
  });
});
