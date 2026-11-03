export interface RtpHeader {
  readonly version: 2;
  readonly padding: boolean;
  readonly extension: boolean;
  readonly csrcCount: number;
  readonly marker: boolean;
  readonly payloadType: number;
  readonly sequenceNumber: number;
  readonly timestamp: number;
  readonly ssrc: number;
  readonly csrc: readonly number[];
}

export interface RtpPacket {
  readonly header: RtpHeader;
  readonly payload: Uint8Array;
}

export class MalformedRtpPacketError extends Error {
  constructor() {
    super('malformed-rtp-packet');
    this.name = 'MalformedRtpPacketError';
  }
}

const FIXED_HEADER_BYTES = 12;
const MAX_CSRC = 15;
const MAX_PAYLOAD_TYPE = 127;

export function nextSequence(current: number): number {
  return (current + 1) & 0xffff;
}

export function nextTimestamp(current: number, samples: number): number {
  return (current + samples) >>> 0;
}

/** Signed distance a - b along the shortest path of the 16-bit sequence circle. */
export function sequenceDelta(a: number, b: number): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

function assertEncodable(header: RtpHeader): void {
  const validCsrc = header.csrcCount === header.csrc.length && header.csrcCount <= MAX_CSRC;
  const validType = header.payloadType >= 0 && header.payloadType <= MAX_PAYLOAD_TYPE;
  if (!validCsrc || !validType) throw new MalformedRtpPacketError();
}

function flagBit(flag: boolean, bit: number): number {
  return flag ? bit : 0;
}

export function encodeRtp(packet: RtpPacket): Uint8Array {
  const { header, payload } = packet;
  assertEncodable(header);
  const headerBytes = FIXED_HEADER_BYTES + header.csrcCount * 4;
  const out = new Uint8Array(headerBytes + payload.length);
  const view = new DataView(out.buffer);
  out[0] =
    0x80 | flagBit(header.padding, 0x20) | flagBit(header.extension, 0x10) | header.csrcCount;
  out[1] = flagBit(header.marker, 0x80) | header.payloadType;
  view.setUint16(2, header.sequenceNumber);
  view.setUint32(4, header.timestamp);
  view.setUint32(8, header.ssrc);
  header.csrc.forEach((id, index) => view.setUint32(FIXED_HEADER_BYTES + index * 4, id));
  out.set(payload, headerBytes);
  return out;
}

function readCsrc(view: DataView, count: number): number[] {
  return Array.from({ length: count }, (_, index) => view.getUint32(FIXED_HEADER_BYTES + index * 4));
}

function readHeader(view: DataView, data: Uint8Array): RtpHeader {
  const first = data[0] as number;
  const second = data[1] as number;
  const csrcCount = first & 0x0f;
  return {
    version: 2,
    padding: (first & 0x20) !== 0,
    extension: (first & 0x10) !== 0,
    csrcCount,
    marker: (second & 0x80) !== 0,
    payloadType: second & 0x7f,
    sequenceNumber: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    csrc: readCsrc(view, csrcCount)
  };
}

/** Parses the fixed header and CSRC list; the payload is returned verbatim (padding and extension are not stripped). */
export function decodeRtp(data: Uint8Array): RtpPacket {
  if (data.length < FIXED_HEADER_BYTES || data[0] === undefined || data[0] >> 6 !== 2) {
    throw new MalformedRtpPacketError();
  }
  const headerBytes = FIXED_HEADER_BYTES + (data[0] & 0x0f) * 4;
  if (data.length < headerBytes) throw new MalformedRtpPacketError();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { header: readHeader(view, data), payload: data.slice(headerBytes) };
}
