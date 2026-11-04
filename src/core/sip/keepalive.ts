/*
 * NAT keepalive and dead-flow detection, as decisions only.
 *
 * Two clocks: the last time we SENT anything (outbound traffic is what keeps a
 * NAT binding open, so it is also what a ping is waiting for) and the last time
 * ANYTHING ARRIVED (the only evidence that the path still works). The timers
 * that call `decideKeepalive` live in src/main.
 */
import type { SipTransport } from './transport';

export interface KeepaliveState {
  readonly lastSentAt: number;
  readonly lastInboundAt: number;
  /** Inbound RTP packets counted across the account's calls when last looked at; see `noteMedia`. */
  readonly mediaPackets: number;
}

export interface KeepalivePolicy {
  /** Send a ping when nothing has been sent for this long. */
  readonly pingIntervalMs: number;
  /** Declare the flow dead when nothing has arrived for this long. */
  readonly deadAfterMs: number;
}

export type KeepaliveAction = 'none' | 'ping' | 'dead';

/**
 * UDP NAT bindings commonly expire after 30 to 120 s of silence (Linux conntrack's unreplied-UDP default is
 * 30 s, many consumer routers use 30 to 60 s). The ping interval is 20 s so that, with the 5 s granularity of
 * the caller's timer, the worst gap between packets is 25 s: under the shortest common timeout, and close to
 * RFC 5626's 24 to 29 s UDP recommendation. PJSIP uses 15 s. Dead after three intervals: two lost pings
 * (or their answers) in a row are tolerated, a third silent interval is not.
 */
export const DATAGRAM_KEEPALIVE: KeepalivePolicy = { pingIntervalMs: 20_000, deadAfterMs: 60_000 };

/**
 * Connection-oriented transports hold their NAT entry for far longer (typically minutes to hours) and report
 * a closed socket themselves, so the ping only has to cover idle-timeouts of middleboxes and half-open
 * connections: 60 s, dead after three.
 */
export const STREAM_KEEPALIVE: KeepalivePolicy = { pingIntervalMs: 60_000, deadAfterMs: 180_000 };

export const keepalivePolicy = (transport: SipTransport): KeepalivePolicy =>
  transport === 'udp' ? DATAGRAM_KEEPALIVE : STREAM_KEEPALIVE;

/**
 * What to send as the keepalive. RFC 5626's CRLF ping (`\r\n\r\n`, answered by `\r\n`) suits datagram and
 * stream transports. WebSocket is the exception: RFC 7118 keeps a connection alive with WebSocket ping
 * frames, which the socket abstraction does not expose, and a text frame holding bare CRLF is not valid SIP
 * there, so a real request, whose answer also proves the path, stays the ping.
 */
export type KeepaliveMethod = 'crlf' | 'options';

export const keepaliveMethod = (transport: SipTransport): KeepaliveMethod =>
  transport === 'ws' || transport === 'wss' ? 'options' : 'crlf';

/** A flow that has just been registered or resumed is alive as of `now`; `mediaPackets` is the count seen so far. */
export const startKeepalive = (now: number, mediaPackets = 0): KeepaliveState => ({
  lastSentAt: now,
  lastInboundAt: now,
  mediaPackets
});

export const noteSent = (state: KeepaliveState, now: number): KeepaliveState => ({ ...state, lastSentAt: now });

export const noteInbound = (state: KeepaliveState, now: number): KeepaliveState => ({ ...state, lastInboundAt: now });

/**
 * RTP arriving on an established call is evidence the network works, so a growing packet count counts as
 * inbound traffic. A count that is unchanged is no evidence either way (a silent or stalled call), and a
 * smaller one (a call ended) is only remembered. This feeds the inference; it does not replace the RTP
 * watchdog in core/rtp/flow.ts, which is what judges whether a call itself is dead.
 */
export const noteMedia = (state: KeepaliveState, mediaPackets: number, now: number): KeepaliveState => ({
  ...state,
  mediaPackets,
  lastInboundAt: mediaPackets > state.mediaPackets ? now : state.lastInboundAt
});

/**
 * Dead outranks ping: there is no point pinging a flow we have already given up on.
 *
 * `holdDead` is for a flow that carries a transaction which cannot be moved to another connection (an
 * outbound INVITE still waiting for its final response: its responses are addressed to this flow's Via).
 * Replacing the flow would strand that transaction, so the verdict is postponed: the flow keeps being pinged
 * and silence is not acted on. The caller owns the end of the wait (the call's own setup timer).
 */
export function decideKeepalive(
  state: KeepaliveState,
  now: number,
  policy: KeepalivePolicy,
  holdDead = false
): KeepaliveAction {
  if (now - state.lastInboundAt >= policy.deadAfterMs && !holdDead) return 'dead';
  return now - state.lastSentAt >= policy.pingIntervalMs ? 'ping' : 'none';
}
