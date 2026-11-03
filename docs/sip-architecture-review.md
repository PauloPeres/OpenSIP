# SIP architecture review: what mature softphones do that we do not

> **Internal engineering document. English only; there is no Portuguese translation of this one.**
> Written 2026-11-03 against the working tree of `/Users/paulo/repos/opensip`. Nothing in this
> review was run against a real SIP server. Where a claim comes from reading our code it says
> "by code reading"; where it comes from a scratch simulation it says "simulated"; where I could
> not verify it, it says **unverified**.

## 1. The short version

1. **We have no SIP transaction layer and no dialog layer in the RFC 3261 sense.** Responses are
   matched to requests by Call-ID plus CSeq (`engine.ts` `onResponse`, `registrar.ts`
   `isFinalFor`), never by Via branch. Retransmission timers exist, but as three separate
   copies (INVITE in `startInviteTimers`, REGISTER in `startRetransmit`, CANCEL cleanup in
   `cancel`). BYE, CANCEL and re-INVITE are sent once and forgotten.
2. **That matters much less than it sounds, because our transport ladder is TLS, WSS, TCP, WS, UDP.**
   On a reliable transport, RFC 3261 sets Timers A, E, G to "do not run" and D, I, J, K to zero.
   What is left (response matching, forked 2xx, 2xx retransmission and ACK) is dialog and
   transaction-user logic, not timer logic. The UDP-only PBX is where the missing layer shows.
3. **The failures a user would actually see come from somewhere else.** In order of how likely
   they are to be felt:
   - an account stuck "failed" forever after a short outage (retry logic gives up after three
     attempts and only retries on 408);
   - inbound calls silently lost because nothing holds the NAT binding or detects a dead socket
     between refreshes (540 s at a 600 s expiry);
   - one-way or dead audio when the far end re-bases its RTP stream, or sends packets that are
     not exactly 20 ms;
   - no early media (183), so ringback and carrier announcements are silent;
   - no answer to a late-offer INVITE (we answer 488).
4. **The pure-core design is the right bet, but it has leaked.** `src/main/sip/engine.ts`
   (1415 lines, not ~1200) holds protocol decisions: Record-Route handling, CSeq comparison,
   ACK construction, forked-2xx handling, auth retry. The unit-test gates (coverage, CRAP,
   mutation) include `src/core/**` only (`vitest.config.*`: `coverage.include`). The engine does
   have scenario tests against a scripted PBX in `tests/unit/media-bridge.spec.ts`, but it is
   outside the numeric gates. The first structural recommendation is to move the pure parts of
   engine.ts into `src/core/sip/`, with no behaviour change.

Top three recommendations (details in section 6): registration resilience, keepalive plus
dead-flow detection, and a media-robustness package (jitter re-base fix, multi-ptime ingest,
RTP-inactivity watchdog, symmetric RTP).

## 2. What we have today

**The unusual constraint.** Every decision is a pure function in `src/core`; `src/main` only
owns sockets, DNS, timers and the audio device (README "Architecture"; ROADMAP "The principle
that shapes the plan"). Of the stacks I read, none is organised like this. PJSIP, Sofia-SIP,
belle-sip and SIP.js all put timers and I/O inside the transaction objects. SIP.js comes closest
(its `core/` layer takes an injected `Transport`), but its transactions still own real
`setTimeout`s. Ours can go further: a reducer that returns *effects* (send, start timer, cancel
timer) is testable with a fake clock and no sockets. That is the same shape as
`reduceRegistration` and `nextCallState` already.

| Area | What exists | Where |
| --- | --- | --- |
| Wire codec | Parse and serialise, compact header forms, folding, byte-accurate Content-Length on TCP framing, tolerant of leading CRLF (so CRLF keepalive pongs already parse as nothing) | `core/sip/message.ts` |
| Auth | Digest MD5 and MD5-sess, qop auth and auth-int, stale handling, repeated-nonce detection | `core/sip/digest.ts`, `registrar.ts` `authenticate` |
| Transport discovery | SRV for five services, default port ladder, preference TLS, WSS, TCP, WS, UDP, SRV priority and weight, probe in order | `core/sip/transport.ts`, `main/sip/prober.ts` |
| Registration | Reducer (`offline`, `registering`, `registered`, `failed`); REGISTER with digest; rport and received learning; refresh at 90% of granted expiry; 3 retries 30 s apart, only for 408 or connection loss; unregister on stop | `core/sip/registration.ts`, `registrar.ts`, `engine.ts` `refresh`/`fail` |
| Binding analysis | Detects other devices on the same AOR and our own displacement from the 200's Contact list | `core/sip/bindings.ts` |
| Calls | Reducer (`ringing`, `connecting`, `active`, `held`, `ended`); UAC and UAS; CANCEL; hold and resume by re-INVITE; 90 s setup guard; user-visible "waiting" state | `core/sip/call.ts`, `engine.ts` |
| SDP | One audio m-line, PCMU/PCMA/telephone-event, direction attributes, hold and resume | `core/sip/sdp.ts` |
| Media | RTP over UDP, G.711 both laws, RFC 4733 DTMF send, fixed-depth jitter buffer, mute that still sends silence, Chromium AEC/NS/AGC via `getUserMedia` | `core/rtp/*`, `main/media/*`, `renderer/src/media/audio.ts` |
| Not present | Transaction layer, dialog layer, 100rel, session timers, UPDATE, INFO, NOTIFY, REFER, early media, late offer, RTCP, STUN/ICE/TURN, SRTP, keepalives, RFC 5626 Outbound, NAPTR, SHA-256 digest, symmetric RTP | |

## 3. How the mature stacks are layered

| Stack | Layers (bottom to top) | Notes for us |
| --- | --- | --- |
| PJSIP / PJSUA2 | pjlib, then PJSIP (message elements, transport, authentication, transaction, base UA/common dialog, UA layer), PJMEDIA, PJNATH (ICE/STUN/TURN), PJSUA-LIB, PJSUA2 | Datasheet lists RFC 4320/4321 compliance (non-INVITE and INVITE transaction fixes), RFC 3262, RFC 4028, RFC 5626 *for TCP/TLS only*, Path, ICE, SRTP (SDES and DTLS). Licence is GPL or commercial. |
| Sofia-SIP | tport (transport), nta (transaction, dialogs/call legs, retransmission of reliable provisionals), nua (call semantics, handles, offer/answer) | nta explicitly tracks "call legs and dialogs" and matches requests to them. |
| belle-sip (liblinphone) | transport (UDP/TCP/TLS, DNS SRV), transaction (RFC 6026 state machines), dialog, plus a "refresher" that re-sends requests and tolerates disconnections | GPLv3 or proprietary. |
| baresip | `libre` (SIP, SDP, RTP/RTCP, STUN/TURN/ICE) plus modules: `ice`, `stun`, `srtp`, `dtls_srtp`, `opus`, `natpmp`, many more | Modular; NAT and crypto are opt-in modules. |
| JsSIP | `Transactions` (4 transaction classes plus ACK), `Dialog`, `RTCSession`, `Registrator`, `Transport` | WebSocket only, so Timers D, I, J, K are set to 0 and there is no Timer A/E/G. Still implements 2xx retransmission and an ACK timeout in the session class. |
| SIP.js | `core/transactions`, `core/dialogs`, `core/user-agents` (one class per method and role), `core/user-agent-core`, then `api/` | Source contains `FIXME: Timer A for unreliable transport not implemented` and `Missing timer G`. So even the JS stacks do not give us UDP reliability for free. |
| Linphone, Jami, MicroSIP, Blink | Linphone: belle-sip plus mediastreamer2. MicroSIP: PJSIP (stated on its site). Jami: its own daemon with SIP accounts supported. Blink: SIP SIMPLE client SDK (relationship to PJSIP **unverified** from the pages I could read). | Product-level patterns, section 8. |

Two patterns recur in every one of them and we lack both: **(a)** a transaction object that
owns its own timers and is keyed by Via branch, and **(b)** a dialog object keyed by
(Call-ID, local tag, remote tag), separate from the transaction that created it.

## 4. The seven questions

### 4.1 Transaction layer (RFC 3261 section 17)

**Do we implement one? No.** What exists instead:

- REGISTER: `registrar.ts` `awaitFinal` subscribes to the connection and accepts the first
  response with `status >= 200` whose Call-ID and CSeq header strings equal the request's
  (`isFinalFor`). Via branch is never compared. Provisional responses are ignored.
- INVITE: `engine.ts` `onResponse` looks the dialog up by Call-ID alone, parses the CSeq with
  `inviteCseq`, and compares it with `dialog.pending.cseq`. `pending` is a single slot, so there
  is one client INVITE transaction per call.
- Anything else is invisible. A response to BYE or CANCEL has `inviteCseq === undefined` and is
  dropped; a 4xx to a re-INVITE is dropped (and is not ACKed); a 2xx to a re-INVITE goes through
  `onReinviteAnswered`.
- Server side: there are no server transactions. Replies are built by `respond` and `reply` and
  sent once. A retransmitted INVITE is recognised by Call-ID in `onKnownInvite`; a retransmitted
  BYE is answered 481 because the dialog is already gone.

**What breaks without it, concretely:**

| Mechanism | Today | Effect |
| --- | --- | --- |
| Timer A/B (INVITE retransmit/timeout) | Implemented in `startInviteTimers` (UDP only). | Fine. Stops on first response of any kind, which is right. |
| Timer E/F (non-INVITE) | REGISTER only (`startRetransmit`). BYE, CANCEL, re-INVITE: sent once. | Over UDP a lost BYE leaves the far end connected while we show "ended". A lost CANCEL leaves the callee ringing. A lost hold re-INVITE leaves our UI "held" while audio still flows. |
| ACK for non-2xx (transaction-level) | `buildFailureAck`, sent once. | Fine on TCP. Over UDP, if that ACK is lost the server retransmits the 4xx; we have already deleted the dialog (`failCall` then `releaseDialog`), so the retransmission is dropped and never re-ACKed. Server holds the transaction for Timer H (32 s). |
| Timer D (client lingering) | Absent. | Same case as above. |
| Timer G/H/I (server INVITE) | Absent. Our 603/486/488 are sent once. | A lost final response over UDP is never retransmitted. |
| Timer J/K, request absorption | Absent. | Retransmitted BYE gets 481 instead of the cached 200. Benign. |
| 2xx retransmit and ACK wait (TU rule, section 13.3.1.4, not a transaction timer) | Absent. See 4.3. | Real call failures over UDP. |
| Forked 2xx on the client (RFC 6026 "Accepted" state) | Not modelled. See 4.2. | Wrong ACK, possible media redirect. |

**Is a real transaction layer worth it?** Yes, but sized correctly and not first.

- On TLS/TCP it buys correct matching and the forked-2xx rule, both of which can be done in a
  dialog table with far less code. On UDP it buys real reliability. Our ladder tries TCP before
  UDP, but UDP-only providers and PBXs are common, so UDP must work, not merely connect.
- It consolidates the three hand-rolled timer copies (engine, registrar, cancel cleanup), which
  also removes duplication that the DRY gate will eventually catch.
- **It belongs in `src/core/sip/` as pure reducers**, in the same style as `reduceRegistration`:
  `reduceClientTx(tx, event, reliability) -> { tx, effects }`, where an event is
  `response | timer(name) | transportError` and an effect is `send(message) | startTimer(name, ms)
  | cancelTimer(name) | deliver(response) | terminated`. `src/main` gets a small runner that
  maps effects to `setTimeout` and `connection.send`. A pure `transactionKey(message)`
  (Via branch plus method; RFC 3261 section 17.1.3 and 17.2.3) replaces the Call-ID/CSeq match.
  Four machines (INVITE client, non-INVITE client, INVITE server, non-INVITE server) with the
  RFC 6026 Accepted state. This is directly testable with a fake clock, which is exactly what
  JsSIP and SIP.js cannot do cheaply.
- Do the non-INVITE client first (REGISTER, BYE, keepalive OPTIONS). It is the smallest and
  replaces `awaitFinal` and `startRetransmit`.

### 4.2 Dialog layer and routing

**Record-Route and route set: mostly correct.**

- UAC: `adoptRemote` takes the Record-Route headers of the 2xx *reversed* (`dialog.routes`), which
  is RFC 3261 section 12.1.2. UAS: `newInbound` keeps them in received order, section 12.1.1.
  `requestHeaders` emits them as `Route` on every in-dialog request. For loose-routing proxies,
  which is all of them today, this is right. A proxy that record-routes will see our BYE and
  re-INVITE with its Route and forward them.
- Remote target is taken from the Contact of the 2xx (UAC) or the INVITE (UAS).

**Deviations, none of which I can tie to a known failure:**

1. `stripBrackets` (engine.ts) removes *all* URI parameters from the remote target
   (`...split(';')[0]`). RFC 3261 section 12.1 says the remote target is the Contact URI, and
   parameters such as `transport`, `ob`, `gr` or vendor tags like Asterisk's `x-ast-orig-host`
   are part of it. Affects the Request-URI of ACK, BYE, re-INVITE.
2. Every in-dialog request goes out on the registration socket (`dialog.entry.connection`),
   regardless of Route or Request-URI. There is no RFC 3263 next-hop resolution. That is the
   standard "outbound proxy" model and works when the registrar is the first hop or forwards
   by Route. It would fail if the first Route names a different host that the registrar will
   not forward for. Unverified against any deployment.
3. No strict-router handling (RFC 2543 style, no `lr`). Acceptable; no one runs those.
4. Early-dialog route set from 18x is ignored. Correct for now (section 13.2.2.4 recomputes
   from the 2xx); will matter if PRACK or UPDATE is added.
5. ACK for a 2xx does not repeat the INVITE's credentials, which section 13.2.2.4 says it MUST.
   A proxy that authenticates ACKs cannot challenge them, so it would drop ours. Unverified
   whether any deployed server does this.

**Dialog identity is the real gap.** The dialog map is keyed by Call-ID only (`this.dialogs`),
and nothing compares From/To tags on in-dialog requests. By code reading, consequences:

- **Forked INVITE, second 2xx.** After the first 2xx, `dialog.pending` is cleared. A second 2xx
  from another branch (different To tag, same Call-ID and CSeq) falls into `onReinviteAnswered`,
  which sends an ACK built from the *first* branch's To tag and, if the body carries different
  media, calls `adoptMedia` and **restarts the RTP session toward the second branch's address**.
  RFC 3261 section 13.2.2.4 says each 2xx with a new To tag is a distinct dialog that must be
  ACKed, and RFC 6026 keeps the client transaction in "Accepted" so these get delivered. The
  usual proxy behaviour (CANCEL the other branches once one answers) makes this a narrow race,
  but a ring group on OpenSIPS or Kamailio is exactly where it appears.
- **BYE from a different fork** with the same Call-ID ends our dialog (`onBye` checks only
  Call-ID).
- **Remote CSeq is not tracked at all.** In `onKnownInvite` the test
  `cseq <= dialog.cseq` compares the *remote's* CSeq with *our own* local counter. If we hold
  an inbound call (our counter becomes 2) and the peer then sends a re-INVITE with CSeq 2, it
  is treated as a retransmission and gets the old SDP back (`resendProvisionalOrFinal`); the
  peer's hold or media change is silently ignored. The same conflation applies when we are the
  UAC and the peer's first re-INVITE has a CSeq not above ours. Many stacks start CSeq at a
  random value, which hides it. RFC 3261 section 12.2.2 requires a separate remote sequence
  number and a 500 for out-of-order requests.
- **Re-INVITE outcomes are not handled.** `hold`/`resume` change local state first
  (`dialog.held = true`, `dispatchCall`) and send the re-INVITE fire-and-forget through
  `sendRequest`. A 491, 488, 408 or 481 never reaches the state machine, so the UI can say
  "held" while the far end did not accept. A 401/407 on an in-dialog request is not retried.
  RFC 3261 section 12.2.1.2: a 408 or 481 to an in-dialog request should terminate the dialog.

**This is where a pure `dialog.ts` pays off:** `dialogId(message, role)`,
`routeSet(record-routes, role)`, `acceptRemoteCseq(dialog, n)`, `classify2xx(table, response)`
returning `confirm | retransmitted | fork`, and `buildInDialogRequest(dialog, method)`. The
builders are already pure functions that happen to live in engine.ts (`buildDialogRequest`,
`buildCancel`, `buildFailureAck`, `buildReply`, `adoptRemote`); moving them is mechanical.

### 4.3 Reliability and session lifetime

**100rel / PRACK (RFC 3262).**
We send no `Supported:` header. Under RFC 3262 section 3 a UAS may send reliable provisionals
only if the INVITE said `Supported: 100rel` or `Require: 100rel`, so by default nobody will
send us one. PJSIP's own default is `PJSUA_100REL_NOT_USED` (verified in `pjsua.h`); Asterisk's
`100rel` option defaults to `yes`, which I read as "use it only if the peer offers it" (the
option text I fetched lists values but does not define `yes`; **unverified**).
*Practical cost of lacking it:* a gateway whose policy mandates reliable provisionals would
answer 420 Bad Extension, and the user would see a generic "call failed" (our
`END_REASON_BY_STATUS` has no 420 entry). I cannot name a server that does this by default.
**Do not build it until a server demands it.** Design the transaction layer so PRACK, a
non-INVITE client transaction inside an early dialog, fits later.

**Session timers (RFC 4028).**
The brief says many PBXs require them and tear calls down without them. My reading of the RFC
is narrower:

- Support is *negotiated*. If the UAC does not advertise `Supported: timer`, and the UAS or a
  proxy wants a timer anyway, Table 2 in section 9 makes the **UAS** the refresher. If the UAS
  does not support timers, a 2xx without `Session-Expires` means no timer is in effect
  (sections 7.2, 8.2).
- So the usual outcome for us is: the PBX sends *us* refresh re-INVITEs (or UPDATE) and we must
  answer them. We do answer re-INVITE (`onKnownInvite`), but see the CSeq bug above, and we
  would answer **488** to a refresh re-INVITE that carries no SDP (`negotiateBody('')` is
  undefined). RFC 4028 allows refreshes without a body. That is the one path where lacking
  timers could end a call we never meant to lose.
- UPDATE would get 405 from us. Our `Allow` does not list UPDATE, and a refresher that honours
  Allow will use re-INVITE (PJSIP-based stacks do this; behaviour of others **unverified**).
- A hard failure exists only where an operator configures the *server* to require timers
  (Asterisk `timers=required`, which I did not find documented in the page I fetched beyond the
  value list), which gives 421.

The real value of session timers is the other half: **detecting a dead call** when the far end
or our machine vanishes without a BYE. Today nothing does (see 4.5). A media-inactivity watchdog
achieves most of that for far less (recommendation 3). PJSIP and JsSIP default to timers
*optional/enabled*; Asterisk's `timers_sess_expires` defaults to 1800 s.

**Early media on 183.**
`PROGRESS_BY_STATUS` maps 183 to "ringing" but the SDP in a 183 is never parsed or acted on, and
no RTP socket exists until the 2xx (`onAnswered` then `startMedia`). Cost: carriers play ringback
and failure announcements ("the number you dialled does not exist") as early media, so the user
hears silence while ringing and silence before an unexplained failure. Also the first words
after answer can be clipped while the NAT pinhole and socket open. This degrades calls and makes
PSTN-bound calls look broken. It is relevant to the open external-number blocker in ROADMAP
(a silent post-100 path), though that blocker has no 183 at all, so early media is **not** the
explanation for it. Effort small to medium: a pure `earlyMediaPlan(response)` in core, a
receive-only RTP session in main that is upgraded at 200.

**Late offer (INVITE without SDP).** Not asked, but belongs here. `onInvite` answers 488 when
`negotiateBody(request.body)` is undefined. Delayed-offer trunks (the 200 carries our offer, the
ACK carries their answer; RFC 3261 sections 13.2.1 and 14.2, RFC 6337) would fail every inbound
call. I cannot say how many of the owner's providers do this. **Unverified frequency, certain
failure when it happens.**

**UAS 2xx retransmission and ACK timeout (RFC 3261 section 13.3.1.4).**
`answer` sends the 200 once. The RFC says the 2xx is retransmitted at T1, doubling to T2, until
an ACK arrives, **independent of transport**, and the session SHOULD be torn down with a BYE
after 64*T1 without an ACK. I quoted that section from the RFC text. JsSIP implements both
(`invite2xxTimer`, `_setACKTimer`) even though it only runs over WebSocket. Ours:

- A lost 200 over UDP is never resent. The caller has already stopped retransmitting INVITE
  because it saw our 180, so `onKnownInvite`'s "resend on retransmitted INVITE" path never
  fires. Result: caller rings until it times out; we sit in `connecting`.
- Media starts only in `onAck`. If the ACK is lost or misrouted, the call is `connecting`
  forever with no media and no timeout. Starting media when the 200 is sent (the far end may
  send RTP immediately) is the common approach and also removes first-words clipping.

### 4.4 Registration robustness

**"Re-register at 90% of expiry and nothing else. Is that enough?" No, but the 90% is not the
problem.** 90% is fine (PJSIP refreshes 5 s before expiry, JsSIP at roughly half to full
interval with jitter). The problems are what happens around it:

1. **Retry logic gives up.** `engine.ts` `fail(entry, reason, retryable)` is called with
   `retryable = (result.status === 408)` after a REGISTER, and `canRetry(snapshot, MAX_RETRIES)`
   with `MAX_RETRIES = 3` and `attempts` only reset on success. So: three attempts 30 s apart,
   then the account stays `failed` until the user toggles it. A 503 from a restarting server, a
   500, a 502, a 480, a DNS blip, or a laptop wake on a new Wi-Fi all produce permanent
   failure. PJSIP retries automatically on 408, 480, 500, 502, 503, 504, 6xx and transport
   failures, indefinitely (`reg_retry_interval`, default 300 s, randomised;
   `pjsua.h`). **Breaks service.**
2. **423 Interval Too Brief is not handled** (JsSIP is: `Registrator.js`, `423` case with
   `Min-Expires`). It falls to `rejected` and, not being 408, is not retried.
3. **`grantedExpiry` reads the wrong Contact.** `registrar.ts` takes the `Expires` header first,
   then the first `expires` parameter found on *any* Contact in the 200. On an account with
   another device registered (a case `bindings.ts` goes out of its way to detect), the first
   Contact may be the other device's, with a different expiry. We would then schedule our
   refresh from someone else's interval and drop off the registrar. RFC 3261 section 10.2.4
   makes the per-Contact `expires` authoritative; use the one matching our own binding (the
   `BindingOwner` matching is already pure in `bindings.ts`). **Degrades or breaks, only with
   shared accounts.**
4. **Every refresh uses a new Call-ID and CSeq 1.** RFC 3261 section 10.2 SHOULD: same Call-ID
   per registrar, increasing CSeq, so the registrar can order delayed requests. Low impact.
5. **No keepalive of any kind.** See 4.4.1.
6. **No network-change or resume trigger.** After sleep or a Wi-Fi change a TCP/TLS socket can
   be dead while Node still thinks it is open. The next write succeeds into the void, the
   10 s response timeout fires, and recovery waits for the next refresh at up to 540 s.
   Electron's `powerMonitor` `resume` and `net.online`/`online` events are the hooks (main).

**4.4.1 NAT holding: keepalives.** Typical consumer NATs expire idle UDP mappings in tens of
seconds to a couple of minutes (**unverified for any specific device**; RFC 5626 section 3.5.2
sizes UDP STUN keepalives at 24 to 29 s, which is the standard's own estimate of the safe
interval). Our default expiry is 600 s. Between refreshes the binding can vanish, and an inbound
INVITE then reaches nothing. PJSIP's default keepalive is **15 s** (`ka_interval`, `pjsua.h`;
TCP default 90 s in `sip_config.h`). RFC 5626 section 3.5.1 CRLF ping for TCP/TLS: double CRLF
every 95 to 120 s with a 10 s pong timeout; a missing pong means the flow is dead.

Our framing already tolerates the pong (`message.ts` `LEADING_BREAKS`). What is missing is the
timer, the send, and the pong deadline. Whether *our* servers answer CRLF pings is **unverified**;
OPTIONS to the server is the universal fallback because every SIP element answers it.
`socket.setKeepAlive(true, 30_000)` on TCP/TLS sockets is a one-line partial measure (detects a
dead peer at the kernel level, does not hold a NAT binding open for most NATs).

**4.4.2 RFC 5626 Outbound and Path.**
- What it does: `+sip.instance` and `reg-id` in Contact, `Supported: outbound, path`, the
  registrar stores the flow, an edge proxy adds a `Path` with a flow token and `ob`, and requests
  to us are sent down the existing flow. Keepalives are mandatory in practice.
- What our current design already does: Contact is built from the rport-learned address, i.e.
  public IP plus the *TCP source port the server sees*. A proxy that reuses an existing
  connection to that remote address (most do) can reach us without any Outbound support.
- When it is not enough: a multi-node SIP edge, where the INVITE originates from a node that
  does not hold our TCP flow. That is the problem flow tokens and Path solve.
- Scope: PJSIP's datasheet lists Outbound for **TCP/TLS only**. For UDP the answer is
  keepalives, not Outbound. `Path` itself is a registrar/proxy concern; the UA only needs to
  advertise `Supported: path`.
- Recommendation: do keepalives first; add `+sip.instance`/`reg-id`/`ob` as a small follow-up
  (header building is pure; ten lines in `registerHeaders`) only when we meet a multi-node edge.

**4.4.3 Digest.** `engine.ts` `credentialsFor` and `registrar.ts` `credentialsFor` read only the
*first* `WWW-Authenticate`/`Proxy-Authenticate` header. RFC 8760 section 2.3 has servers list
several algorithms in preference order, strongest first, and section 2.4 says the client uses
the topmost one *it supports* and ignores the rest. Our `parseAlgorithm` throws
`UnsupportedAlgorithmError` for SHA-256, so against a server that offers SHA-256 first and MD5
second we would fail registration although an MD5 challenge was right there. Asterisk added
`supported_algorithms_uas` in 20.12 / 21.7 / 22.2 (documented option; its default **unverified**).
This is a pure-core fix (parse all challenges, choose the first supported) of an hour or two,
and SHA-256 itself is a small addition on top.

### 4.5 Media

**RTCP: what we lose.**
We reserve port+1 in `allocateRtpPort` but never bind or use it, and advertise nothing about it
(the default is RTP+1). Losses:
- The far end's view of our stream (loss, jitter, RTT from RR/SR). This is the one diagnostic we
  lack for the "I cannot hear them / they cannot hear me" class of bug, which is exactly the open
  MVP item ("no real call has been heard yet"). Our own counters (`MediaStats`) only show what we
  received.
- RTCP BYE and SDES CNAME. Irrelevant for audio-only G.711.
- Per RFC 3550 section 6.2 an RTP session without RTCP is simply non-compliant. In practice:
  **I found no evidence that mainstream servers drop an audio stream for lack of RTCP.**
  Asterisk's dead-stream detection is RTP based (`rtp_timeout`, `rtp_timeout_hold`, default 0 =
  off, from the res_pjsip option reference). Whether some SBCs or media gateways do is
  **unverified**. WebRTC gateways need RTCP for feedback, but that is not our case.
- ICMP port-unreachable for packets arriving at port+1 (peers that send RTCP to a closed port).
  Some stacks treat a socket error as stream failure. **Unverified.**
Classification: **not table stakes for interop; table stakes for diagnosis.** Minimum: bind
port+1; send SR/RR plus SDES CNAME about every 5 s (RFC 3550 section 6.2 minimum); parse inbound
SR/RR into `MediaStats`. A pure `rtcp.ts` codec in `core/rtp` (about 300 lines with tests).

**Jitter buffer (found while reading `core/rtp/jitter.ts`): a real defect, simulated.**
`pull()` advances `cursor` one sequence per tick and treats any gap as loss. If the far end
re-bases its stream (new SSRC and an unrelated random sequence number: after a transfer,
a call-forward leg change, a media server taking over, music-on-hold from a different source),
two cases:
- new sequence ahead of the cursor: recovers in about `maxDepth` packets (about 0.2 s). Fine.
- new sequence *behind* the cursor: every packet fails `slotFor` (`sequenceDelta(seq, cursor) < 0`)
  and is counted as a duplicate; the cursor never moves because the queue is empty. I ran the
  real `createJitterBuffer` in a scratch script: with a re-base 900 sequence numbers behind,
  **nothing played for 900 packets (18 s)**, and with a re-base about 30000 behind, **nothing
  played for the full 30 s test** (the theoretical worst case is about 11 minutes). That is
  total receive-side silence on a call that otherwise looks healthy.
Fix is pure and tiny: reset the buffer when the SSRC changes or when a packet is more than
N sequence numbers from the cursor (what WebRTC NetEq, PJMEDIA's jbuf and Speex JB all do in
some form). `rtp-session.ts` `onDatagram` never looks at SSRC.

**Packet size.** `Session.accept` keeps only payloads of exactly `SAMPLES_PER_FRAME` (160)
bytes. A peer that sends 10 ms, 30 ms or 40 ms packets (a=ptime is a hint, RFC 4566; our
`a=ptime:20` is in both offer and answer) has all of its audio **silently discarded**. How often
a peer ignores our ptime is **unverified**; PSTN gateways at 30 ms are the usual suspect. Fix:
split any multiple of 80 bytes into frames (pure function in `core/rtp`).

**Jitter buffer design.** Fixed depth of 3 frames (60 ms), no adaptation, no re-prebuffering after
a pause, no packet-loss concealment (a gap plays silence). Acceptable for LAN/PBX, audibly rough
on bad Wi-Fi. PJMEDIA has an adaptive jitter buffer, adaptive delay buffer and PLC. *Nice to
have.* Also, playback is driven by a main-process `setInterval(20)`, so event-loop stalls become
audio glitches; whether that is audible in practice is **unverified**, there being no real call
yet. The renderer's AudioWorklet playback has its own prime/limit buffer, which helps.

**Dead-call detection.** Nothing notices that RTP stopped. With no session timers and no RTCP,
a call whose far end disappears stays "active" forever. A pure `mediaWatchdog(lastRxAt, now,
held)` with a threshold (Asterisk `rtp_timeout` is the model; use a long hold threshold) is the
cheapest dead-call detector there is.

**Symmetric RTP / latching.** We send to the address in the SDP (`MediaPlan`), full stop, and
accept datagrams from anyone. Standard practice (Asterisk `rtp_symmetric`, rtpengine/rtpproxy
latching, PJSIP symmetric media) is to learn the real source from the first valid inbound
packet and send there. It fixes: a far end behind NAT advertising a private address; and
servers that proxy media from a different address than the one in SDP. Guard it: require the
negotiated payload type, lock to the first SSRC, and allow re-latch only after a silence gap, to
limit RTP injection. Pure decision in core (`latchTarget`), one extra argument in
`RtpSocket.onMessage` for the source address. **Table stakes.**

**Comfort noise (PT 13) and VAD.** We do not offer CN. A peer that sends it anyway gets
dropped by `onDatagram` and shows up as "lost" in the stats (harmless audibly, wrong in the
number). The telephone-event path already uses the same "silent stand-in" trick; apply it to PT
13 if it ever shows up. *Nice to have, low value.*

**Telephone-event payload type.** `sdpFor` always emits payload 101 in answers even when the
offer used another number (96, 100, 126 are in the wild). Sending works (we use the peer's
number), receiving uses ours. We do not decode inbound DTMF, so this is spec-correctness only.
Also an answer must be a subset of the offer (RFC 3264 section 6): we add 101 even if the offer
had none.

**Opus versus G.711.** G.711 is the universal baseline and correct as the only codec for a first
release. Opus is the quality upgrade but needs an encoder: a native module (packaging cost on
three platforms) or **Chromium WebCodecs `AudioEncoder`/`AudioDecoder` in the existing media
window (unverified in Electron 33.2, which ships Chromium 130; needs a spike)**. G.722 is the
cheaper wideband step: no native dependency, a pure algorithm that belongs in `core/rtp`, and it
is accepted by essentially every PBX and phone. Its one trap is the RTP timestamp clock
(8000 Hz for a 16 kHz codec, RFC 3551). *Nice to have, after the interop items.*

**SRTP and ZRTP.** Signalling over TLS with plaintext RTP gives a false sense of security, and
some providers and PBXs mandate SRTP (Asterisk `media_encryption=sdes|dtls`, default `no`).
SDES (RFC 4568 `a=crypto`, AES_CM_128_HMAC_SHA1_80 per RFC 3711) is implementable with
`node:crypto` and fits `core/rtp` as pure functions; its key exchange is only safe over TLS
signalling, which our ladder prefers. DTLS-SRTP needs a DTLS stack Node does not ship; ZRTP is
niche (Twinkle and Linphone offer it). **SDES: table stakes for a TLS-first product; DTLS-SRTP
and ZRTP: not now.** Needs a product decision on policy (prefer, require, off).

### 4.6 NAT for media

**What we do.** `engine.ts` `hostOfEntry` puts the rport-learned public IP in `c=`; the `m=`
port is our *local* RTP port from `allocateRtpPort`. Signalling over TCP/TLS teaches us the
public IP but the "port" it learns is the TCP source port, which is irrelevant to media.

**When this fails in the real world:**
1. The NAT does not preserve the port. A home NAT usually tries to; a corporate firewall, a
   mobile hotspot or any carrier-grade NAT often does not. The far end sends RTP to
   `publicIP:localPort` and nothing is listening there. Result: **one-way audio**.
2. The server does not latch/symmetric-RTP, and the NAT is address- or port-restricted. Result:
   inbound RTP is dropped until the NAT has seen us send to that exact source. We do send as soon
   as media starts, which rescues the common cone-NAT case.
3. The far end is itself NATed and advertises a private address (direct-media between two
   NATed phones; Asterisk's `direct_media` defaults to `yes`). We never latch, so we send into
   the void. One-way or no audio.
4. Multi-homed hosts and VPNs: the interface that reached the SIP server is not the media
   interface, so the rport-derived address is wrong for RTP.
5. IPv6-only paths (the RTP socket is `udp4`).

**Minimum viable improvement, in this order:**
1. Symmetric RTP / latching (section 4.5). Covers cases 2 and 3 with no STUN server and no new
   protocol. Pure decision, small I/O change.
2. STUN Binding on the RTP socket (RFC 5389 is a small codec: `core/rtp/stun.ts`) before the
   offer, advertise the *mapped* IP *and port* in `c=`/`m=`. Covers case 1 and 4. Needs a
   configurable STUN server (default: the account's own domain, fall back to none; sending
   binding requests to a third-party public server is a privacy choice we should make
   consciously, not silently).
3. Only if both prove insufficient: ICE-lite or full ICE. The mature stacks (PJNATH, baresip
   `ice`, Linphone) do implement full ICE, mostly for peer-to-peer and for media that does not
   traverse the PBX. **A softphone whose media always anchors at a PBX or SBC does not need
   it.** TURN likewise.

### 4.7 Things you did not ask about but matter

1. **Late offer** (4.3) and **refresh re-INVITE without SDP**: both answered 488.
2. **Dialog identity and forking** (4.2).
3. **Quality gates do not reach the engine.** Coverage, CRAP and mutation run on `src/core/**`
   only. The most defect-prone code in the project (dialog and ACK handling) is outside them.
   Moving the pure parts into core fixes that structurally. This is the strongest argument for the
   refactor, stronger than elegance.
4. **Network change and sleep/wake** as first-class events (4.4).
5. **SDP offer/answer hygiene** (`sdp.ts`): `o=` version is never incremented on re-INVITE
   (`sdpFor` reuses the session id for both fields; RFC 3264 section 8 says to increment on
   change). I expected this to break hold against PJSIP-based PBXs; reading PJSIP's
   `sdp_neg.c` shows it does **not** compare the remote `o=` version at all, so I withdraw the
   concern as a known failure and keep it as spec hygiene. Also: only the first audio m-line is
   parsed and the answer contains only one m-line (RFC 3264 section 6 wants one answer m-line per
   offer m-line, in order, so a video offer is mishandled); `Supported` and `Allow` are not
   included in 2xx responses (RFC 3261 section 13.3.1.4 SHOULD); IPv4 only.
6. **Method coverage.** Unknown methods get 405 (good). NOTIFY (MWI, REFER progress), INFO and
   UPDATE are not handled. INFO is used by some PBXs for DTMF; we offer RFC 4733 in SDP, which
   is the better path. Not needed now.
7. **TLS name verification.** `openStream` passes the SRV *target* as `servername`, so
   certificates are checked against the SRV target. RFC 5922 verifies against the original SIP
   domain. Which one a given provider's certificate covers is **unverified**; it matters only if
   SRV points to a host the certificate does not name. Verification is on by default, which is
   better than several softphones' defaults.
8. **Licensing.** Embedding a stack is not free: PJSIP is GPL or commercial, belle-sip GPLv3 or
   proprietary, Sofia-SIP LGPL (from memory), baresip BSD-3 and JsSIP/SIP.js MIT (SIP.js
   licence file read; JsSIP and baresip licences from memory for JsSIP, header read for
   baresip). Our project is MIT. Linking PJSIP would force a relicence or a commercial licence,
   independent of the architecture argument.

## 5. Gap table

Severity: **breaks** = calls or registration fail; **degrades** = works with worse behaviour;
**limits** = a feature is missing. Effort: S under a day, M one to three days, L about a week or
more, for one engineer who knows this code.

| # | Gap | What mature stacks do | Cost to us in practice | Severity | Effort |
| --- | --- | --- | --- | --- | --- |
| G1 | Registration gives up after 3 tries, retries only on 408 (`engine.ts fail`) | PJSIP retries 408/480/500/502/503/504/6xx and transport errors forever with randomised delay | Server restart or laptop wake leaves the account `failed` until user action | **breaks** | S |
| G2 | No keepalive, no dead-flow detection | PJSIP 15 s default (TCP 90 s); RFC 5626 CRLF ping/pong or STUN | Inbound calls lost behind NAT between refreshes; dead TCP socket undetected up to 540 s | **breaks** inbound | S to M |
| G3 | 423 not handled; refresh interval read from the wrong Contact; new Call-ID each refresh | JsSIP handles 423, matches own Contact by instance/reg-id or URI | Registration rejected by some servers; mis-scheduled refresh on shared accounts | breaks/degrades | S |
| G4 | No wake/online triggers | Linphone refresher "tolerates disconnections"; PJSIP IP-change handling | Recovery waits for next refresh after sleep or Wi-Fi change | degrades | S |
| G5 | Jitter buffer cannot recover from a stream re-base | Reset on SSRC/sequence discontinuity | Total receive silence for seconds to minutes (simulated) | **breaks** audio | S |
| G6 | Inbound audio dropped unless exactly 20 ms | Handle any ptime | Silent one-way audio from peers that ignore ptime (frequency unverified) | **breaks** audio | S |
| G7 | No RTP inactivity watchdog | Asterisk `rtp_timeout`; session timers | Zombie "active" calls | degrades | S |
| G8 | No symmetric RTP / latching | Standard in Asterisk, rtpengine, PJSIP | One-way audio with NATed far ends or relays | **breaks** audio in those cases | S |
| G9 | UAS 2xx not retransmitted; no ACK timeout; media waits for ACK | RFC 3261 13.3.1.4; JsSIP does both | Lost 200 on UDP or lost ACK: call never completes, stuck `connecting` | **breaks** (UDP, lossy paths) | S to M |
| G10 | Remote CSeq conflated with local counter | Separate remote sequence, 500 on out-of-order | Peer re-INVITE ignored after we hold | degrades | S |
| G11 | No early media | PJSIP, baresip, Linphone all do | Silent ringback and carrier announcements | degrades | S to M |
| G12 | Late-offer INVITE / body-less refresh answered 488 | Offer/answer state machine | Inbound calls from delayed-offer trunks fail | **breaks** (those peers) | M |
| G13 | Dialog keyed by Call-ID only; forked 2xx mishandled | Dialog id = Call-ID + both tags; RFC 6026 Accepted state | Wrong ACK, possible media redirect, wrong BYE target on forked calls | degrades/breaks (forking) | M |
| G14 | Re-INVITE/BYE/CANCEL fire-and-forget; re-INVITE outcome ignored | Non-INVITE and INVITE client transactions | Lost BYE/CANCEL on UDP; UI "held" while not held | degrades | M to L |
| G15 | No transaction layer (branch matching, Timers A/E/G/D/H/I/J/K) | Every stack in section 3 | UDP reliability; also code duplication (3 timer copies) | degrades (UDP) | L |
| G16 | Digest: first challenge only, no SHA-256 | RFC 8760 client behaviour | Registration fails against servers that list SHA-256 first | **breaks** (those servers) | S |
| G17 | No SRTP | PJSIP SDES+DTLS, baresip srtp/dtls_srtp, Linphone SDES/DTLS/ZRTP | TLS-only signalling, plaintext audio; fails against providers that require SRTP | limits / breaks | M to L |
| G18 | No STUN; advertised RTP port is local port | PJNATH, baresip stun/ice | One-way audio behind port-changing NATs | degrades | M |
| G19 | No RTCP | RTCP everywhere | No far-end quality view; no mainstream server dropping streams found | limits (diagnosis) | M |
| G20 | No session timers | PJSIP optional, JsSIP on by default, Asterisk configurable | Mostly none (UAS can be refresher); body-less refresh gets 488 (see G12) | limits | S to M |
| G21 | No 100rel/PRACK | PJSIP supports, default not used | Gateways that mandate it reject with 420 (none identified) | limits | M |
| G22 | No RFC 5626 Outbound (`+sip.instance`, `reg-id`, `ob`) | PJSIP (TCP/TLS), JsSIP always sends | Only matters behind multi-node edges | limits | S (headers) to M |
| G23 | Fixed jitter buffer, no PLC | Adaptive jitter buffer and PLC (PJMEDIA) | Rough audio on bad networks | degrades | M |
| G24 | G.711 only | Opus, G.722 everywhere | Narrowband audio | limits | M (G.722) / L (Opus) |
| G25 | URI parameters stripped from remote target; ACK for 2xx lacks credentials; `o=` version never bumped; answer is not a strict subset | RFC-exact | No failure identified | spec hygiene | S |

## 6. Ranked recommendations

Highest payoff per unit of effort first. "Core" = pure and unit-testable in `src/core`; "Main" =
I/O in `src/main`. Every item should be implemented core-first with the failing test written
before the adapter, per CONTRIBUTING.

**Step 0 (structural, no behaviour change, do alongside 1 to 3): move the pure parts of
`engine.ts` into `src/core/sip/`.** `buildReply`, `buildDialogRequest`, `buildInvite`,
`buildCancel`, `buildFailureAck`, `requestHeaders`, `contactFor`, `adoptRemote`, `negotiateBody`,
`identityOf`, `inviteCseq`, and the end-reason table. They take plain data and return plain data
already. Result: the same decisions now sit inside the coverage, CRAP and mutation gates, and
everything below has somewhere to land. Effort S to M. Core.

1. **Registration resilience (G1, G3, G4).** Core: `registerRetryDelay(attempt, status,
   retryAfter, random)` with exponential backoff capped around 5 minutes and randomised (RFC 5626
   section 4.5 gives the formula, base 30 s, cap 1800 s); `isRecoverable(status)` using the PJSIP
   list; `adjustExpiresFor423`; `grantedExpiry` selecting the Contact that matches our own
   binding. Remove the `MAX_RETRIES` ceiling (a user-visible "retrying in N s" replaces
   "failed"). Main: trigger an immediate retry on `powerMonitor` `resume` and on regaining
   connectivity; keep one Call-ID per boot with an incrementing CSeq. Effort S. **Do this first:
   it is the cheapest change that turns a permanent failure into a self-healing one.**

2. **Keepalive and dead-flow detection (G2).** Core: `keepalivePlan(transport)` returning
   interval, payload and pong deadline, plus a small reducer (`idle`, `pinging`, `dead`) so the
   rules are testable with a fake clock. TCP/TLS: double CRLF every 95 to 120 s randomised, 10 s
   pong deadline, then drop the connection and re-register (this reuses recommendation 1's
   backoff). UDP: CRLF or OPTIONS every 15 to 25 s. Fall back to OPTIONS where CRLF pongs are not
   returned (verify against the owner's OpenSIPS first; **unverified**). Enable
   `socket.setKeepAlive` as well. Main: the timers and the write. Effort S to M.

3. **Media robustness package (G5, G6, G7, G8).** Core (`core/rtp`): jitter re-base on SSRC change
   or large sequence discontinuity; frame splitter for 10/20/30/40 ms payloads;
   `mediaWatchdog`; `latchTarget`. Main (`rtp-session.ts`): pass the datagram source through,
   read SSRC, report inactivity to the engine (which logs a warning first, ends the call after a
   long threshold). Effort S to M. **The jitter defect is reproduced, so this has a test to
   start from.**

4. **Inbound answer path hardening (G9, G10, G12).** Core: `uas2xxSchedule` (T1 doubling to T2,
   give up at 64*T1 and send BYE), a separate remote-CSeq check, a minimal offer/answer state
   (early offer, late offer, body-less refresh), `Supported`/`Allow` in 2xx. Main: start media
   when the 200 is sent, not on ACK. Effort M. Biggest wins on UDP and on delayed-offer peers.

5. **Early media (G11).** Core: `earlyMediaPlan(response)`; main: receive-only RTP session
   started on 180/183 with SDP, upgraded in place at 200, with a few silent packets sent
   immediately to open the NAT pinhole. Effort S to M.

6. **Digest multi-challenge and SHA-256 (G16).** Core only. Parse every challenge header, pick the
   first supported, add SHA-256 (and SHA-512-256 if cheap). Effort S.

7. **Dialog table and re-INVITE outcomes (G13, G14 part, G25).** Core `dialog.ts` as in 4.2; key
   the engine map by Call-ID plus both tags; forked extra 2xx gets ACK plus BYE and never touches
   media; re-INVITE failure reverts hold state; 408/481 in a dialog ends the call; ACK carries
   the INVITE's credentials; keep URI parameters on the remote target. Effort M.

8. **Pure transaction layer (G14, G15).** As described in 4.1. Non-INVITE client first (REGISTER,
   BYE, OPTIONS keepalive), then INVITE client with the Accepted state, then the two server
   machines. Effort L, but incremental and each stage removes ad hoc code. Core for the machines
   and `transactionKey`; main for the effect runner. Do this once 1 to 7 are in: they remove the
   most visible failures, and by then the transaction layer has real call sites to serve.

9. **STUN-mapped RTP address (G18), then minimal RTCP (G19).** Core: STUN and RTCP codecs; main:
   one binding request before the offer, SR/RR timer. Effort M each.

10. **SRTP with SDES (G17).** Core: key generation, `a=crypto` parse/build, SRTP protect and
    unprotect. Main: policy setting. Effort M to L. Needs a product decision (prefer, require,
    off) and, honestly, a first real provider that needs it.

11. **Only when a server demands them:** session timers (G20), 100rel/PRACK (G21), Outbound
    parameters (G22), G.722 then Opus (G24), adaptive jitter and PLC (G23).

## 7. What we should NOT adopt

A focused softphone copying a carrier-grade stack's surface would be a mistake. Specifically:

- **Embedding PJSIP, Sofia-SIP or belle-sip (native bindings).** Licences (GPL/commercial,
  LGPL, GPLv3/proprietary) conflict with our MIT licence; a native addon on three platforms
  undoes the "single codebase, auto-update" story; and it ends the pure-core architecture, which
  is the project's differentiator and the thing that makes 100% core coverage meaningful.
- **Full ICE, TURN, Trickle ICE.** They exist in PJNATH/baresip for peer-to-peer and for media
  that bypasses the PBX. Ours anchors at the server. Latching plus optional STUN covers the real
  failures. Revisit only if direct-media peers become a product requirement.
- **DTLS-SRTP and ZRTP.** DTLS needs a stack Node does not ship; ZRTP is niche. SDES over TLS is
  the interoperable minimum.
- **NAPTR (RFC 3263 section 4.1).** We query the transport-specific SRV names directly and probe,
  which reaches the same answer without a NAPTR lookup. Adding it adds a failure mode (broken
  NAPTR records) for no gain. The SRV weight handling is deterministic (highest weight wins)
  instead of RFC 2782 weighted-random; acceptable for a client.
- **GRUU, Service-Route, multiple dialog usages (RFC 5057), SUBSCRIBE/NOTIFY event framework,
  presence, MESSAGE, REFER/Replaces, conferencing.** Already "not planned" in ROADMAP. Each is a
  large surface with no failure a current user would hit.
- **A generic "SIP user agent library" abstraction (SIP.js `user-agents/` one class per method and
  role).** Keep the engine's shape: a small number of reducers over plain data. Add methods when a
  server needs them.
- **Full RFC 5626 Outbound with multiple flows and an outbound-proxy set.** One flow, keepalive,
  and fast re-registration cover a single-server softphone.
- **UDP-first investment in the transaction layer before the cheap fixes.** The ladder prefers
  TCP/TLS; build the layer after items 1 to 7.
- **Session timers just because the RFC exists.** The watchdog gives the benefit; negotiate timers
  only if a server insists.
- **Tuning the 90% refresh fraction.** It is fine.

## 8. What we do well, or better suited to our constraints

- **The pure-core pattern** itself (section 2): effects-as-data transaction machines would be a
  cleaner design than any of the JS or C stacks' timer-owning objects.
- **Automatic encrypted-first transport discovery** from just a domain (`transport.ts`,
  `prober.ts`). PJSIP leaves transport choice to the application; the softphones I read ask the
  user. We probe SRV and defaults in preference order and choose the best reachable one.
- **TCP framing** (`message.ts` `nextFrame`): byte-accurate Content-Length over UTF-8, bounded
  buffer (`MAX_BUFFER_BYTES`), tolerates CRLF between messages.
- **Unconnected UDP socket** (`connection.ts` `openDatagram`): the comment explains why; this is
  what RFC 3261 response matching requires and avoids dropping answers that come from another
  port.
- **Digest handling** is solid within MD5: stale handling, repeated-nonce detection, qop, MD5-sess.
- **Binding analysis** (`bindings.ts`): reading the 200's Contact list to tell the user another
  device holds the account or that we were displaced is a user-facing diagnostic I did not find
  in the stacks I read (not an exhaustive search).
- **Audio front end**: `getUserMedia` with `echoCancellation`, `noiseSuppression`,
  `autoGainControl` plus an AudioWorklet gives us Chromium's WebRTC audio processing for free.
  PJSIP lists WebRTC AEC3 as an optional component to bundle. Caveat: not verified end to end,
  since no real call has been heard.
- **Mute sends silence instead of stopping** (`rtp-session.ts`), which keeps the NAT binding and
  the far end's stream alive. Asterisk exposes the same idea as `rtp_keepalive`.
- **Call-setup guard with a visible "waiting" state** (`engine.ts`
  `CALL_SETUP_TIMEOUT_MS`/`CALL_WAITING_GRACE_MS`): a deliberate, documented deviation from
  RFC 3261 Timer B semantics. I did not compare it with other stacks' behaviour.
- **Diagnostics log with credential redaction and raw wire trace** is the kind of thing that makes
  every item above debuggable.

## 9. Claims in the brief that the research contradicted or narrowed

1. *"`engine.ts` ... is where dialogs and transactions are handled today."* Dialogs, partly
   (Call-ID keyed). Transactions are not handled; there is a single `pending` slot and a header
   comparison. File length is 1415 lines.
2. *"Session timers, which many PBXs require and will tear calls down without."* Not supported by
   what I could verify. RFC 4028 negotiates the feature and lets the UAS refresh without us;
   PJSIP and JsSIP treat it as optional. The failure I found runs the other way: a body-less
   refresh re-INVITE would get 488 from us. Whether any common PBX tears down calls from a UA
   without timer support is **unverified**.
3. *"Do any servers drop a stream with no RTCP?"* I found no evidence of one. Asterisk's inactivity
   detection is RTP-based and off by default.
4. *"We re-register at 90% of expiry and nothing else."* True, but the 90% is not the weakness. The
   retry policy (three tries, 408 only) and the absent keepalive are.
5. *My own hypothesis that the `o=` version bug breaks hold against PJSIP-based PBXs* is refuted by
   PJSIP source: it does not compare the remote version.
6. *RFC 5626 Outbound as the answer to NAT bindings.* PJSIP's datasheet scopes Outbound to
   TCP/TLS, and for TCP our Contact already matches the server-visible flow. Keepalives are the
   prerequisite either way.
7. *Product-level notes on Twinkle, Blink and Jami* are thin: Twinkle's page confirmed ZRTP and
   STUN only; Blink's SDK page did not name PJSIP; Jami's page confirmed SIP accounts and ICE
   during handover only. I did not read their source.

## 10. Unverified items, collected

- Whether the owner's OpenSIPS answers CRLF pings, and whether it needs `;alias`/Outbound for any
  TCP flow behaviour beyond what the live registration already shows.
- Frequency of peers that ignore `a=ptime:20` (G6) and of delayed-offer trunks (G12).
- Behaviour of non-PJSIP stacks when a refresher's UPDATE or re-INVITE is refused.
- Asterisk `timers=yes` semantics, `100rel=yes` semantics, and the default of
  `supported_algorithms_uas`.
- WebCodecs Opus availability and quality in Electron 33.2.
- Whether the main-process 20 ms `setInterval` playback clock produces audible glitches.
- Specific NAT idle timeouts of the owner's networks.
- Licences of Sofia-SIP, JsSIP and baresip (from memory or file header only).
- Whether any real server authenticates in-dialog ACK or BYE (G25).

## 11. Sources

Read in this session (full text, source, or documentation):

- RFC 3261, SIP: <https://www.rfc-editor.org/rfc/rfc3261.txt> (sections 10.2, 12.2.2, 13.2.2.4,
  13.3.1.4 and the transaction timers text read directly)
- RFC 3262, Reliability of Provisional Responses: <https://www.rfc-editor.org/rfc/rfc3262.html>
- RFC 4028, Session Timers: <https://www.rfc-editor.org/rfc/rfc4028.html>
- RFC 5626, Managing Client-Initiated Connections (Outbound): <https://www.rfc-editor.org/rfc/rfc5626.html>
  (first 100,000 characters read)
- RFC 6026, Correct Transaction Handling for 2xx Responses to INVITE: <https://www.rfc-editor.org/rfc/rfc6026.html>
- RFC 8760, SHA-256 and SHA-512/256 for Digest: <https://www.rfc-editor.org/rfc/rfc8760.html>
- PJSIP SIP capabilities: <https://docs.pjsip.org/en/latest/overview/features_sip.html>
- PJSIP NAT traversal: <https://docs.pjsip.org/en/latest/overview/features_nat.html>
- PJSIP media features: <https://docs.pjsip.org/en/latest/overview/features_media.html>
- PJSIP codecs: <https://docs.pjsip.org/en/latest/overview/features_codec.html>
- PJSIP `pjsua.h` (keepalive 15 s, registration retry list, 100rel and timer defaults):
  <https://github.com/pjsip/pjproject/blob/master/pjsip/include/pjsua-lib/pjsua.h>
- PJSIP `sip_config.h` (TCP keepalive 90 s, refresh 5 s before expiry):
  <https://github.com/pjsip/pjproject/blob/master/pjsip/include/pjsip/sip_config.h>
- PJSIP `sdp_neg.c` (no remote `o=` version comparison):
  <https://github.com/pjsip/pjproject/blob/master/pjmedia/src/pjmedia/sdp_neg.c>
- Sofia-SIP NTA module: <https://sofia-sip.sourceforge.net/refdocs/nta/index.html>
- Sofia-SIP NUA module: <https://sofia-sip.sourceforge.net/refdocs/nua/index.html>
- belle-sip: <https://github.com/BelledonneCommunications/belle-sip>
- Liblinphone: <https://www.linphone.org/technical-corner/liblinphone>
- baresip: <https://github.com/baresip/baresip>
- JsSIP source (`Transactions.ts`, `Timers.ts`, `Registrator.js`, `RTCSession.js`, `Dialog.js`,
  `Transport.ts`): <https://github.com/versatica/JsSIP/tree/master/src>
- JsSIP configuration parameters: <https://jssip.net/documentation/3.10.x/api/ua_configuration_parameters/>
- SIP.js source (`core/transactions`, `core/dialogs`, `core/user-agents`):
  <https://github.com/onsip/SIP.js/tree/main/src/core>
- Asterisk res_pjsip option reference (`rtp_timeout`, `rtp_keepalive`, `timers`, `100rel`,
  `supported_algorithms_uas`, `media_encryption`, `direct_media`):
  <https://docs.asterisk.org/Latest_API/API_Documentation/Module_Configuration/res_pjsip/>
- MicroSIP: <https://www.microsip.org/>
- SIP SIMPLE client SDK (Blink's SDK): <https://github.com/AGProjects/python3-sipsimple>
- Jami daemon: <https://github.com/savoirfairelinux/jami-daemon>
- Twinkle: <https://github.com/LubosD/twinkle>

Cited but not read in this session (my knowledge, treat as lower confidence): RFC 3263 (SIP
server location), RFC 3264 (offer/answer; sections 6 and 8), RFC 3550 (RTP/RTCP), RFC 3551
(G.722 timestamp rule), RFC 3581 (rport), RFC 3711 (SRTP), RFC 4566 (SDP), RFC 4568 (SDES),
RFC 4733 (telephone-event), RFC 5389 (STUN), RFC 5922 (SIP domain certificates), RFC 6337
(offer/answer usage), RFC 2782 (SRV).

Our code, read in full for this review: `src/core/sip/{message,digest,transport,registration,call,sdp,
bindings}.ts`, `src/core/rtp/{packet,jitter}.ts` (`g711.ts` not read),
`src/main/sip/{connection,registrar,prober,engine}.ts`, `src/main/media/rtp-session.ts`,
`README.md`, `ROADMAP.md`, and the engine scenarios in `tests/unit/media-bridge.spec.ts`
(names only). One scratch script, outside the repository, ran `createJitterBuffer` to reproduce
the re-base behaviour. No live test was run.
