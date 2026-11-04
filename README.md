# Open SIP Phone

[![ci](https://github.com/PauloPeres/OpenSIP/actions/workflows/ci.yml/badge.svg)](https://github.com/PauloPeres/OpenSIP/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A free, open source and radically simple SIP softphone.** Configure multiple SIP
accounts, see each one register, and answer incoming calls — on macOS, Windows and
Linux, from a single codebase, with automatic updates.

🇧🇷 [Leia em português](README.pt-BR.md)

---

## Features

- **Multiple SIP accounts** — register several accounts at the same time and see the
  registration state of each one live.
- **Place calls** — a dialer with one line per call, verified on a real call with audio
  heard in both directions.
- **Receive calls** — ring, answer, reject, hold, resume and hang up, with a configurable
  limit of concurrent calls. The signalling is implemented and tested; taking an incoming
  call in the app with audio has not been confirmed yet.
- **Call history and redial** — every finished call is listed with its time, direction
  (incoming or outgoing), the remote number or address, the account that carried it, its
  outcome (answered, missed, declined, cancelled or failed) and, when it connected, how
  long it lasted. Entries are grouped by day, with "Today" and "Yesterday" written in the
  interface language. A **Missed** filter shows only unanswered incoming calls, any entry
  can be removed on its own, and **Clear history** wipes the list after a confirmation.
  Clicking an entry redials it through the same path as the dialer; the history keeps the
  most recent 500 calls and survives a restart.
- **Configurable SIP User-Agent** — under **Settings**, for providers that only accept
  clients they recognise; see [Troubleshooting](#troubleshooting).
- **Bilingual interface** — English and Brazilian Portuguese, selectable at runtime.
  Not a single user-facing string is hardcoded; CI enforces it.
- **Updates** — built on `electron-updater`. Automatic on Windows and Linux (AppImage);
  on macOS the app tells you a new version exists and links to the download until it is
  signed with an Apple Developer ID (see [Install](#install)).
- **Credentials at rest are encrypted** with Electron `safeStorage` when the platform
  supports it.
- **Quality enforced by machine, not by opinion** — see [Quality gates](#quality-gates).

## Transport: you give it a domain, it works out the rest

You are not asked for a port, a protocol or a WebSocket URL. Give Open SIP Phone a username,
a password and a domain, and it finds the way in:

1. It queries the SRV records defined by RFC 3263 and RFC 7118 — `_sips._tcp`,
   `_sips._wss`, `_sip._tcp`, `_sip._ws`, `_sip._udp`.
2. If the domain publishes none, it falls back to the default port ladder
   (TLS 5061, TCP 5060, UDP 5060, WSS 443, WS 80).
3. It probes the candidates in order of preference — **TLS, WSS, TCP, WS, UDP**,
   encrypted first, then reliable — and keeps the first that answers, respecting SRV
   priority and weight.

**Supported transports: TLS, TCP, UDP, WSS and WS.** SIP over TCP and UDP is spoken by
a native stack in the Electron main process, so a plain Asterisk, FreeSWITCH, Kamailio
or OpenSIPS endpoint works without any WebSocket module.

If you need to pin one specific path, set the optional server field under **Advanced**
(or `OPENSIP_ACCOUNT_<N>_SERVER_URI`) to something like `tcp://pbx.example.com:5060`.

## Troubleshooting

### What this phone says it is

By default Open SIP Phone identifies itself in the SIP `User-Agent` header as
`Z 5.6.16 v2.10.20.18`, which is the identity of Zoiper 5. It is not Zoiper; it is a
compatibility identity. Many providers silently discard INVITEs from agents they do not
recognise, and this is the value that was measured to connect against one such server. The
choice is shown in **Settings → SIP User-Agent** as *Compatibility: Zoiper 5*. The app's own
names, `OpenSIPPhone/0.1.0` and `OpenSIPPhone`, are available there too, and so is a custom
value. If your provider accepts the app under its own name, use that. Asking the provider to
allow Open SIP Phone is the better long-term fix.

### Calls vanish: no ringing, no error, nothing

If registration works, but an outgoing call never progresses — the server answers
`100 Trying` and then nothing: no ringing, no `407` authentication challenge, no
rejection — your provider may be filtering on the SIP `User-Agent` header.

This is a real-world constraint, not a quirk of one server. Carriers and session border
controllers commonly accept only clients they recognise, as an anti-fraud measure, and some
**silently discard** the INVITE of any other client instead of refusing it. A softphone that
cannot be told what to identify as is unusable behind one.

It was found this way: an OpenSIPS 3.3.10 server answered an INVITE that carried Open SIP
Phone's own `User-Agent` (`OpenSIPPhone/0.1.0`) with `100 Trying` twice and then
nothing, ever — no `180`, no `407`, no final response, not even a reply to our CANCEL. The
two `100`s show the request was accepted and a transaction created, so this is not a packet
lost on the network: the server simply never produced a final answer. A second, already
recognised softphone placed the same call from the same machine, and the server answered it with
`407 Proxy Authentication Required`; the call then rang and connected. Everything else in
the two requests was equivalent, so the header was the difference.

**What to do.**

- The correct fix is on the provider's side: ask them to allow Open SIP Phone, or to tell
  you which `User-Agent` values they accept.
- While that is being arranged, set **Settings → SIP User-Agent**. The value is saved, and
  the next message sent carries it. New calls use it immediately; a registration uses it the
  next time it renews, so turn the account off and on to apply it at once. Leave the field
  empty to go back to the default. The `OPENSIP_USER_AGENT` environment variable provides
  the initial value before you have chosen one.
- Treat it as a workaround, not as the normal way to use the app. Use a value your provider
  has told you to use, not a guess at what another product sends.

### A dialled number needs its full prefix

On the same server, `55500000396` was answered `404 UNALLOCATED_NUMBER`, while
`055500000396` connected. That is the provider's dialplan, not the app: the number must be
dialled exactly as the dialplan expects, including any trunk or international prefix. It
is the kind of thing that wastes an afternoon, so check it first. A leading `+` (E.164) was
also refused by that server, with `484 Address Incomplete`.

## Install

Download the installer for your platform from the
[Releases](https://github.com/PauloPeres/OpenSIP/releases) page:

- **macOS** — `Open-SIP-Phone-<version>-mac-<arch>.dmg` (Intel and Apple Silicon)
- **Windows** — `Open-SIP-Phone-<version>-win-<arch>.exe`
- **Linux** — `Open-SIP-Phone-<version>-linux-x86_64.AppImage` or `.deb`

The app checks for updates on startup and every six hours.

- **Windows and Linux (AppImage)** — updates download in the background and install when
  you quit. Windows shows a SmartScreen warning on first run because the installer is
  not code-signed. The `.deb` does not update itself.
- **macOS** — the build is not signed with an Apple Developer ID yet, and macOS refuses
  to apply updates to such apps. The app notifies you when a new version exists and
  offers a button to open the download page; install it over the old one.
  Maintainers: see [docs/releasing.md](docs/releasing.md).

## Run from source

```bash
git clone https://github.com/PauloPeres/OpenSIP.git
cd OpenSIP
npm install
npm run dev
```

### Seeding development accounts

Copy the template and fill in real credentials — `.env.local` is git-ignored:

```bash
cp .env.example .env.local
```

```dotenv
OPENSIP_ACCOUNT_1_DISPLAY_NAME=Support
OPENSIP_ACCOUNT_1_USERNAME=1001
OPENSIP_ACCOUNT_1_PASSWORD=secret
OPENSIP_ACCOUNT_1_DOMAIN=pbx.example.com
OPENSIP_ACCOUNT_1_SERVER_URI=tcp://pbx.example.com:5060
OPENSIP_ACCOUNT_1_REGISTER_EXPIRES=600
```

Up to nine accounts (`OPENSIP_ACCOUNT_1_*` … `OPENSIP_ACCOUNT_9_*`) are read. An entry
is only seeded when `USERNAME`, `PASSWORD` and `DOMAIN` are filled in, so gaps and
half-filled blocks are simply skipped. `SERVER_URI` is optional — leave it empty for
automatic discovery; the legacy `WS_SERVER` name is still accepted. A separate, optional
`OPENSIP_USER_AGENT` is the initial value of the SIP User-Agent setting until you choose
one in **Settings**. Seeding happens **only in
development** (`!app.isPackaged`) and **only when no account is stored yet**; packaged
builds ignore the file entirely.

### Build installers

```bash
npm run dist
```

## Architecture

```
src/core/      pure, framework-free domain — no Electron, no DOM, 100% unit tested
  i18n/        translator + en/pt-BR dictionaries
  history/     call history: journal, outcomes, retention cap and redial rules
  sip/         account validation, account store, registration and call state
               machines, transport discovery, SIP wire codec and digest auth
  rtp/         G.711 codecs, RTP packets, jitter buffer
  diagnostics/ diagnostics log and credential redaction
  config/      development account seeding from the environment
src/main/      Electron main process: windows, IPC, storage, auto-update
  sip/         native SIP stack: transport prober, sockets, registration and calls,
               and the User-Agent setting (user-agent.ts)
  media/       RTP session and the hidden audio window (microphone and speaker)
src/preload/   contextBridge surface — the only path between renderer and main
src/renderer/  React UI; every string goes through t()
src/shared/    the IPC contract shared by all three processes
```

The rule that keeps this testable: **every decision lives in `src/core` as a pure
function** — state transitions, transport ordering, message framing, digest responses.
`src/main/sip` only owns sockets and DNS, and feeds events into the core reducers,
which is why the whole protocol can be tested exhaustively without a PBX.

### Status

| Capability | State |
| --- | --- |
| Multiple accounts, validation, persistence | working |
| Automatic transport discovery (SRV + probe) | working |
| Registration over TCP, TLS, UDP, WS, WSS | working |
| Incoming call signalling: ring, answer, reject, hang up | implemented; inbound INVITEs were received and answered with `180` in a test harness, but no incoming call has been taken in the app with audio |
| Placing calls: dialer, one line per call | working — an outbound call connected on a real account |
| Call history and redial | working, unit-tested; not yet exercised end to end on a real call |
| Per-account on/off switch | working |
| Diagnostics log with credential redaction | working |
| Onboarding: microphone and notification permissions, first account | working |
| Configurable SIP User-Agent (Settings) | working |
| **Two-way audio (RTP/G.711)** | **verified on a real outbound call, heard in both directions** |

The MVP — making and receiving calls with several accounts — is functionally complete,
and the last unverified item was the audio: the owner placed a real outbound call that
connected with two-way audio. The audio path is also tested in
isolation: `src/core/rtp` (G.711 µ-law and A-law, RFC 3550 packets, a jitter buffer) and
`src/main/media` (the RTP session and the hidden audio window) are unit-tested, and a UDP
loopback test carried audio both ways with zero loss.

What that one call does **not** prove, and what has not been confirmed separately:
answering an incoming call and hearing audio both ways, and two accounts in use at once,
with a call on each. No release has been published yet. The roadmap lists each of these
as met or not met. The call only completed once the SIP `User-Agent` was one the provider
recognised; see [Troubleshooting](#troubleshooting).

What comes after that, in order, is in the [roadmap](ROADMAP.md).

## Quality gates

Every gate runs in CI on each push and pull request. Run them all locally with:

```bash
npm run verify
```

| Gate | Threshold | Command |
| --- | --- | --- |
| Types | no errors, `strict` + `exactOptionalPropertyTypes` | `npm run typecheck` |
| Lint | complexity ≤ 8, ≤ 20 lines per function, depth ≤ 3 | `npm run lint` |
| i18n | zero hardcoded UI strings, dictionaries in sync | `npm run gate:i18n` |
| Coverage | ≥ 95% lines/functions/statements, ≥ 90% branches | `npm run test:coverage` |
| Behaviour (Gherkin) | all scenarios pass | `npm run test:bdd` |
| CRAP | every function < 10 | `npm run gate:crap` |
| Duplication | no clone ≥ 5 lines / 40 tokens | `npm run gate:dry` |
| Mutation | ≥ 90% mutation score | `npm run gate:mutation` |

See [docs/quality-gates.md](docs/quality-gates.md) for what each one checks and how to
fix a failure.

## Contributing

Pull requests are welcome. The workflow is test-first: write a failing unit test or
Gherkin scenario, watch it fail for the right reason, then make it pass. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Open SIP Phone Contributors
