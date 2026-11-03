export type SdpDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';

export interface SdpMedia {
  readonly port: number;
  readonly payloadTypes: readonly number[];
  readonly direction: SdpDirection;
  readonly rtpmap: Readonly<Record<number, string>>;
}

export interface SessionDescription {
  readonly origin: {
    readonly username: string;
    readonly sessionId: string;
    readonly version: string;
    readonly address: string;
  };
  readonly connectionAddress: string;
  readonly audio: SdpMedia;
}

export class MalformedSdpError extends Error {
  constructor() {
    super('malformed-sdp');
    this.name = 'MalformedSdpError';
  }
}

export class NoCommonCodecError extends Error {
  constructor() {
    super('no-common-codec');
    this.name = 'NoCommonCodecError';
  }
}

const CRLF = '\r\n';
const TELEPHONE_EVENT = 101;
const DEFAULT_PAYLOAD_TYPES: readonly number[] = [0, 8];
/** Voice codecs in the order we prefer them, regardless of the caller's list. */
const CODEC_PREFERENCE: readonly number[] = [0, 8];
const DIRECTIONS: readonly SdpDirection[] = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

const RTPMAP: Readonly<Record<number, string>> = {
  0: 'PCMU/8000',
  8: 'PCMA/8000',
  [TELEPHONE_EVENT]: 'telephone-event/8000'
};

const ANSWER_DIRECTION: Readonly<Record<SdpDirection, SdpDirection>> = {
  sendrecv: 'sendrecv',
  sendonly: 'recvonly',
  recvonly: 'sendonly',
  inactive: 'inactive'
};

const HOLD: Readonly<Record<SdpDirection, SdpDirection>> = {
  sendrecv: 'sendonly',
  sendonly: 'sendonly',
  recvonly: 'inactive',
  inactive: 'inactive'
};

const RESUME: Readonly<Record<SdpDirection, SdpDirection>> = {
  sendrecv: 'sendrecv',
  sendonly: 'sendrecv',
  recvonly: 'recvonly',
  inactive: 'recvonly'
};

export function holdDirection(current: SdpDirection): SdpDirection {
  return HOLD[current];
}

export function resumeDirection(current: SdpDirection): SdpDirection {
  return RESUME[current];
}

/**
 * A payload type with no entry in RTPMAP would render as `a=rtpmap:<n> ` with an
 * empty codec name, which is invalid SDP. Refuse loudly instead of putting that
 * on the wire, where the far end's failure would be far harder to trace back.
 */
export class UnknownPayloadTypeError extends Error {
  readonly payloadType: number;

  constructor(payloadType: number) {
    super('unknown-payload-type');
    this.name = 'UnknownPayloadTypeError';
    this.payloadType = payloadType;
  }
}

function codecName(type: number): string {
  const name = RTPMAP[type];
  if (name === undefined) {
    throw new UnknownPayloadTypeError(type);
  }
  return name;
}

function mediaLines(port: number, types: readonly number[], direction: SdpDirection): string[] {
  return [
    `m=audio ${port} RTP/AVP ${types.join(' ')}`,
    ...types.map((type) => `a=rtpmap:${type} ${codecName(type)}`),
    `a=fmtp:${TELEPHONE_EVENT} 0-16`,
    'a=ptime:20',
    `a=${direction}`
  ];
}

export function buildOffer(params: {
  address: string;
  port: number;
  sessionId: string;
  payloadTypes?: readonly number[];
  direction?: SdpDirection;
}): string {
  const { address, port, sessionId } = params;
  const types = [...(params.payloadTypes ?? DEFAULT_PAYLOAD_TYPES), TELEPHONE_EVENT];
  const header = ['v=0', `o=- ${sessionId} ${sessionId} IN IP4 ${address}`, 's=-', `c=IN IP4 ${address}`, 't=0 0'];
  return [...header, ...mediaLines(port, types, params.direction ?? 'sendrecv')].join(CRLF) + CRLF;
}

interface Sections {
  readonly session: readonly string[];
  readonly audio: readonly string[];
}

/** Splits into the session-level lines and the lines of the first m=audio block. */
function splitSections(lines: readonly string[]): Sections {
  const first = lines.findIndex((line) => line.startsWith('m='));
  const start = lines.findIndex((line) => line.startsWith('m=audio '));
  if (start < 0) throw new MalformedSdpError();
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('m='));
  const end = next < 0 ? rest.length : next;
  return { session: lines.slice(0, first), audio: [lines[start] as string, ...rest.slice(0, end)] };
}

function valueOf(lines: readonly string[], prefix: string): string | undefined {
  const found = lines.find((line) => line.startsWith(prefix));
  return found?.slice(prefix.length);
}

function directionOf(lines: readonly string[]): SdpDirection | undefined {
  const found = lines.find((line) => line.startsWith('a=') && DIRECTIONS.includes(line.slice(2) as SdpDirection));
  return found === undefined ? undefined : (found.slice(2) as SdpDirection);
}

function connectionOf(lines: readonly string[]): string | undefined {
  return valueOf(lines, 'c=')?.split(' ')[2];
}

function parseRtpmap(lines: readonly string[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (const line of lines.filter((l) => l.startsWith('a=rtpmap:'))) {
    const [type, codec] = line.slice('a=rtpmap:'.length).split(' ');
    map[Number(type)] = codec ?? '';
  }
  return map;
}

function parseMedia(audio: readonly string[], sessionDirection: SdpDirection | undefined): SdpMedia {
  const [, portText = '', , ...types] = (audio[0] as string).slice(2).split(' ');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new MalformedSdpError();
  return {
    port,
    payloadTypes: types.map(Number),
    direction: directionOf(audio) ?? sessionDirection ?? 'sendrecv',
    rtpmap: parseRtpmap(audio)
  };
}

function parseOrigin(line: string | undefined, fallbackAddress: string): SessionDescription['origin'] {
  const [username = '-', sessionId = '0', version = '0', , , address = fallbackAddress] = line?.split(' ') ?? [];
  return { username, sessionId, version, address };
}

export function parseSdp(raw: string): SessionDescription {
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const { session, audio } = splitSections(lines);
  const connectionAddress = connectionOf(audio) ?? connectionOf(session);
  if (connectionAddress === undefined) throw new MalformedSdpError();
  return {
    origin: parseOrigin(valueOf(session, 'o='), connectionAddress),
    connectionAddress,
    audio: parseMedia(audio, directionOf(session))
  };
}

export function negotiate(
  offer: SessionDescription,
  supported: readonly number[]
): { payloadType: number; direction: SdpDirection } {
  const common = (type: number): boolean =>
    type !== TELEPHONE_EVENT && offer.audio.payloadTypes.includes(type) && supported.includes(type);
  const payloadType = [...CODEC_PREFERENCE, ...supported].find(common);
  if (payloadType === undefined) throw new NoCommonCodecError();
  return { payloadType, direction: ANSWER_DIRECTION[offer.audio.direction] };
}
