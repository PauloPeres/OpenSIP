# OpenSIP

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
- **Answer incoming calls** — ring, answer, reject, hold, resume and hang up, with a
  configurable limit of concurrent calls.
- **Bilingual interface** — English and Brazilian Portuguese, selectable at runtime.
  Not a single user-facing string is hardcoded; CI enforces it.
- **Automatic updates** — built on `electron-updater`, so a release reaches users
  without them downloading anything by hand.
- **Credentials at rest are encrypted** with Electron `safeStorage` when the platform
  supports it.
- **Quality enforced by machine, not by opinion** — see [Quality gates](#quality-gates).

## Transport: you give it a domain, it works out the rest

You are not asked for a port, a protocol or a WebSocket URL. Give OpenSIP a username,
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

## Install

Download the installer for your platform from the
[Releases](https://github.com/PauloPeres/OpenSIP/releases) page:

- **macOS** — `OpenSIP-<version>-mac-<arch>.dmg` (Intel and Apple Silicon)
- **Windows** — `OpenSIP-<version>-win-<arch>.exe`
- **Linux** — `OpenSIP-<version>-linux-x64.AppImage` or `.deb`

The app checks for updates on startup and every six hours, and installs them on quit.

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
automatic discovery; the legacy `WS_SERVER` name is still accepted. Seeding happens **only in
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
  sip/         account validation, account store, registration and call state
               machines, transport discovery, SIP wire codec and digest auth
  config/      development account seeding from the environment
src/main/      Electron main process: windows, IPC, storage, auto-update
  sip/         native SIP stack: transport prober, sockets, REGISTER transactions
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
| Incoming call signalling: ring, answer, reject, hang up | working |
| **Two-way audio (RTP/G.711)** | **not yet — next milestone** |

Answering a call currently completes the SIP signalling only. The RTP media path is
the next milestone and is tracked openly rather than implied.

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

[MIT](LICENSE) © OpenSIP Contributors
