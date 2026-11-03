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

## Transport: read this before you report a bug

OpenSIP talks **SIP over WebSocket** (`ws://` / `wss://`), the transport browsers and
Electron can actually open. It does **not** speak SIP over plain UDP or TCP.

Your PBX or provider must expose a WebSocket SIP endpoint. Most modern ones do:

| Platform | Typical WebSocket endpoint |
| --- | --- |
| Asterisk (`res_http_websocket`) | `wss://pbx.example.com:8089/ws` |
| FreeSWITCH (`mod_sofia` WSS profile) | `wss://pbx.example.com:7443` |
| Kamailio / OpenSIPS (`websocket` module) | `wss://sip.example.com:443` |

If your provider is UDP-only, put a WebSocket-capable proxy (Kamailio, OpenSIPS or
Asterisk) in front of it.

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
OPENSIP_ACCOUNT_1_WS_SERVER=wss://pbx.example.com:8089/ws
OPENSIP_ACCOUNT_1_REGISTER_EXPIRES=600
```

Up to nine accounts (`OPENSIP_ACCOUNT_1_*` … `OPENSIP_ACCOUNT_9_*`) are read. An entry
is only seeded when `USERNAME`, `PASSWORD`, `DOMAIN` and `WS_SERVER` are all filled in,
so gaps and half-filled blocks are simply skipped. Seeding happens **only in
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
  sip/         account validation, account store, registration and call state machines
  config/      development account seeding from the environment
src/main/      Electron main process: windows, IPC, storage, auto-update, sip.js adapter
src/preload/   contextBridge surface — the only path between renderer and main
src/renderer/  React UI; every string goes through t()
src/shared/    the IPC contract shared by all three processes
```

The rule that keeps this testable: **all state transitions live in `src/core` as pure
functions.** `src/main/sip-engine.ts` is a thin adapter that translates sip.js events
into core events and nothing more, which is why the domain can be exhaustively tested
without a PBX.

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
