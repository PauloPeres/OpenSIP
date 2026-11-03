export type SipTransport = 'tls' | 'wss' | 'tcp' | 'ws' | 'udp';
export type CandidateSource = 'manual' | 'srv' | 'default';

/** Encrypted first, then reliable. */
export const TRANSPORT_PREFERENCE: readonly SipTransport[] = ['tls', 'wss', 'tcp', 'ws', 'udp'];

export const DEFAULT_PORTS: Readonly<Record<SipTransport, number>> = {
  tls: 5061,
  tcp: 5060,
  udp: 5060,
  wss: 443,
  ws: 80
};

export const TRANSPORT_ERROR_KEYS = {
  invalidDomain: 'transport.error.invalid-domain',
  unsupported: 'transport.error.unsupported',
  noneReachable: 'transport.error.none-reachable'
} as const;

export interface TransportCandidate {
  readonly transport: SipTransport;
  readonly host: string;
  readonly port: number;
  readonly source: CandidateSource;
  readonly weight: number;
  readonly srvPriority: number;
}

export interface SrvRecord {
  readonly transport: SipTransport;
  readonly name: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

export type ProbeOutcome =
  | { readonly candidate: TransportCandidate; readonly ok: true; readonly latencyMs: number }
  | { readonly candidate: TransportCandidate; readonly ok: false; readonly errorKey: string };

type OkOutcome = Extract<ProbeOutcome, { ok: true }>;

/** RFC 3263 / RFC 7118 service names to query, in preference order. */
export const SRV_SERVICES: readonly {
  readonly service: string;
  readonly transport: SipTransport;
}[] = [
  { service: '_sips._tcp', transport: 'tls' },
  { service: '_sips._wss', transport: 'wss' },
  { service: '_sip._tcp', transport: 'tcp' },
  { service: '_sip._ws', transport: 'ws' },
  { service: '_sip._udp', transport: 'udp' }
];

export class InvalidDomainError extends Error {
  constructor() {
    super('invalid-domain');
    this.name = 'InvalidDomainError';
  }
}

export class UnsupportedTransportError extends Error {
  readonly value: string;

  constructor(value: string) {
    super('unsupported-transport');
    this.name = 'UnsupportedTransportError';
    this.value = value;
  }
}

export class NoReachableTransportError extends Error {
  constructor() {
    super('no-reachable-transport');
    this.name = 'NoReachableTransportError';
  }
}

export const transportLabelKey = (transport: SipTransport): string => `transport.${transport}`;

export const candidateKey = (candidate: TransportCandidate): string =>
  `${candidate.transport}://${candidate.host}:${candidate.port}`.toLowerCase();

const cleanDomain = (domain: string): string => {
  const trimmed = domain.trim();
  if (trimmed === '') {
    throw new InvalidDomainError();
  }
  return trimmed;
};

export function srvQueryNames(domain: string): readonly string[] {
  const clean = cleanDomain(domain);
  return SRV_SERVICES.map((entry) => `${entry.service}.${clean}`);
}

const make = (
  transport: SipTransport,
  host: string,
  port: number,
  source: CandidateSource
): TransportCandidate => ({ transport, host, port, source, weight: 0, srvPriority: 0 });

export function candidatesFromSrv(records: readonly SrvRecord[]): readonly TransportCandidate[] {
  return records.map((record) => ({
    ...make(record.transport, record.name.replace(/\.$/, ''), record.port, 'srv'),
    weight: record.weight,
    srvPriority: record.priority
  }));
}

export function defaultCandidates(domain: string): readonly TransportCandidate[] {
  const clean = cleanDomain(domain);
  return TRANSPORT_PREFERENCE.map((transport) =>
    make(transport, clean, DEFAULT_PORTS[transport], 'default')
  );
}

const SCHEME_TRANSPORT: Readonly<Record<string, SipTransport>> = {
  tls: 'tls',
  wss: 'wss',
  tcp: 'tcp',
  ws: 'ws',
  udp: 'udp'
};

const SIP_SCHEME_DEFAULT: Readonly<Record<string, SipTransport>> = { sip: 'tcp', sips: 'tls' };

const SCHEME_PATTERN = /^(?:([a-z][a-z0-9+.-]*):\/\/|(sips?):)(.*)$/i;
const TRANSPORT_PARAM = /;transport=([^;?]+)/i;
const HOST_PORT = /^(?:[^@/;?]*@)?([^:/;?\s]+)(?::(\d+))?/;

const lookupTransport = (name: string): SipTransport => {
  const found = SCHEME_TRANSPORT[name.toLowerCase()];
  if (found === undefined) {
    throw new UnsupportedTransportError(name);
  }
  return found;
};

const sipTransport = (scheme: string, rest: string): SipTransport => {
  const param = TRANSPORT_PARAM.exec(rest)?.[1];
  return param === undefined
    ? (SIP_SCHEME_DEFAULT[scheme.toLowerCase()] as SipTransport)
    : lookupTransport(param);
};

const resolveTransport = (match: RegExpExecArray | null, rest: string): SipTransport => {
  if (match === null) {
    return 'tcp';
  }
  const [, urlScheme, sipScheme] = match;
  return urlScheme === undefined
    ? sipTransport(sipScheme as string, rest)
    : lookupTransport(urlScheme);
};

export function manualCandidate(uri: string): TransportCandidate {
  const trimmed = uri.trim();
  const match = SCHEME_PATTERN.exec(trimmed);
  const rest = match === null ? trimmed : (match[3] as string);
  const transport = resolveTransport(match, rest);
  const target = HOST_PORT.exec(rest);
  if (target === null) {
    throw new InvalidDomainError();
  }
  const port = target[2] === undefined ? DEFAULT_PORTS[transport] : Number(target[2]);
  return make(transport, target[1] as string, port, 'manual');
}

type Comparator = (a: TransportCandidate, b: TransportCandidate) => number;

const SOURCE_RANK: Readonly<Record<CandidateSource, number>> = { manual: 0, srv: 1, default: 2 };

const isSrv = (c: TransportCandidate): boolean => c.source === 'srv';

const bySource: Comparator = (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
const byPriority: Comparator = (a, b) =>
  (isSrv(a) ? a.srvPriority : 0) - (isSrv(b) ? b.srvPriority : 0);
const byWeightDescending: Comparator = (a, b) => (isSrv(b) ? b.weight : 0) - (isSrv(a) ? a.weight : 0);
const byPreference: Comparator = (a, b) =>
  TRANSPORT_PREFERENCE.indexOf(a.transport) - TRANSPORT_PREFERENCE.indexOf(b.transport);
const byKey: Comparator = (a, b) => {
  const [ka, kb] = [candidateKey(a), candidateKey(b)];
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

const CHAIN: readonly Comparator[] = [bySource, byPriority, byWeightDescending, byPreference, byKey];

const compareCandidates: Comparator = (a, b) =>
  CHAIN.reduce((result, compare) => (result === 0 ? compare(a, b) : result), 0);

export function orderCandidates(
  candidates: readonly TransportCandidate[]
): readonly TransportCandidate[] {
  const seen = new Set<string>();
  return [...candidates].sort(compareCandidates).filter((candidate) => {
    const key = candidateKey(candidate);
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
}

export function buildCandidates(params: {
  readonly domain: string;
  readonly manualUri?: string;
  readonly srvRecords?: readonly SrvRecord[];
}): readonly TransportCandidate[] {
  const manual = params.manualUri === undefined ? [] : [manualCandidate(params.manualUri)];
  return orderCandidates([
    ...manual,
    ...candidatesFromSrv(params.srvRecords ?? []),
    ...defaultCandidates(params.domain)
  ]);
}

const reachableOutcomes = (outcomes: readonly ProbeOutcome[]): OkOutcome[] =>
  outcomes.filter((outcome): outcome is OkOutcome => outcome.ok);

const compareOutcomes = (a: OkOutcome, b: OkOutcome): number =>
  compareCandidates(a.candidate, b.candidate) || a.latencyMs - b.latencyMs;

export function selectBestCandidate(outcomes: readonly ProbeOutcome[]): TransportCandidate {
  const [best] = reachableOutcomes(outcomes).sort(compareOutcomes);
  if (best === undefined) {
    throw new NoReachableTransportError();
  }
  return best.candidate;
}

export function summariseProbe(outcomes: readonly ProbeOutcome[]): {
  readonly reachable: number;
  readonly failed: number;
  readonly best: TransportCandidate | undefined;
} {
  const reachable = reachableOutcomes(outcomes);
  const [best] = reachable.sort(compareOutcomes);
  return {
    reachable: reachable.length,
    failed: outcomes.length - reachable.length,
    best: best?.candidate
  };
}
