# Releasing

A release is deliberate: nothing is built or published by a commit. You bump the
version, push a tag, review the draft it produces, and publish it yourself.

## Cut a release

1. Be on a clean, up-to-date `main` with CI green.
2. Bump the version and tag it:

       npm run release:patch    # or release:minor / release:major

   This runs typecheck, lint and tests first (`preversion`), then `npm version`,
   which edits `package.json` and `package-lock.json`, commits
   `chore(release): vX.Y.Z` and creates the tag `vX.Y.Z`.
3. Push the commit and the tag together:

       npm run release:push     # git push --follow-tags

4. The `release` workflow starts on the tag. Watch it under **Actions**.
5. When it is green, open **Releases**. There is a **draft** `vX.Y.Z` holding every
   installer. Download and try at least one, read the notes, edit them if you want.
6. Click **Publish release**. This is the step that reaches users.

To start a release without pushing a tag, run the `release` workflow by hand from the
**Actions** tab (`workflow_dispatch`). It builds whatever `package.json` says on the
branch you pick and still only produces a draft.

## What the workflow does

`.github/workflows/release.yml`, on a `v*` tag or by hand:

1. **check** reads the version from `package.json` and fails if the tag differs
   (`v0.2.0` against `0.1.0` stops here, before anything is built). It also refuses to
   run for a version that is already published.
2. **quality** calls `ci.yml` as a reusable workflow, so the release runs exactly the
   gates every push runs (typecheck, lint, i18n, coverage, BDD, CRAP, duplication,
   mutation). It passes `package: false`, which skips CI's own `build` job (a plain
   Vite bundle on three operating systems): step 3 packages every platform anyway, and
   running both would ask GitHub for two macOS runners where one does the real work.
3. **build** runs on `macos-latest` (x64 and arm64), `windows-latest` (x64 and arm64)
   and `ubuntu-latest` (x64), each calling `electron-builder --publish always`. Every
   platform uploads its installers and its metadata file to the same draft
   (`electron-builder.yml` sets `releaseType: draft`).
4. **verify-draft** fails unless the draft holds `latest.yml`, `latest-mac.yml`,
   `latest-linux.yml` and a `.dmg`, `.zip`, `.exe`, `.AppImage` and `.deb`.

Every job has a `timeout-minutes` (quality 30, CI build 20, check and verify-draft 10,
release build 45), so a hung job fails in a bounded time. Note this limits a job once
it is running; it is not known to shorten the time a job can wait for a scarce runner.

Pushing `main` and a tag together starts `ci` (for `main`) and `release` (for the tag).
Both finish quality at about the same time, so `ci`'s macOS build and the release's
macOS packaging can be requested together. If macOS runners are scarce, push `main`
first and the tag once `ci` is green: the tag alone starts only `release`. A tag does
not trigger `ci`; the release runs the full quality gate itself.

Needed secrets: only `GITHUB_TOKEN`, which GitHub provides. The workflow asks for
`contents: write`. No repository variables are used. The optional `MAC_CSC_LINK` and
`MAC_CSC_KEY_PASSWORD` secrets are described in the TODO below and need not exist.

## Why a draft

`electron-updater` reads only **published** releases. Until you publish the draft the
updater finds nothing, so installed apps are untouched and you can inspect, edit or
delete the draft freely. After publishing, a release's metadata should not change; to
fix a bad release, publish a higher version. The "No published versions on GitHub" log
line on a first run just means no release has been published yet.

## What the app does with a release

The app checks on startup and every six hours.

| Platform | Behaviour |
| --- | --- |
| Windows (NSIS) | Downloads in the background, installs when the app quits. Unsigned, so first-time installers meet a SmartScreen warning. |
| Linux (AppImage) | Downloads in the background, installs when the app quits. The `.deb` does not self-update. |
| macOS, ad-hoc signed | Tells the user a version is available (status bar and Settings) with a button that opens the release page. It does not download. |
| macOS, Developer ID signed | Behaves like Windows and Linux. |

The macOS rule lives in `src/main/update-policy.ts`. Squirrel.Mac checks the code
signature before applying an update and an ad-hoc signature fails that check, so
downloading would only end in an error. At startup the app runs `codesign -dv` on its
own bundle: it self-updates only when the signature carries a real `TeamIdentifier`.
Ad-hoc, unsigned, or an unreadable answer all fall back to notify-only. Because it
reads the signature of the running build, a certificate added later switches
macOS to automatic updates with no code or flag change.

## Verify a release worked

1. Draft complete: the `verify-draft` job is green; the asset list matches the table above.
2. Metadata sane: `latest*.yml` open and list the right `version`.
3. Before publishing, install the previous version, then publish the new one.
4. Launch the old version (a packaged build; dev builds never check). On
   Windows/Linux the Settings text moves to "downloaded" and the new version installs on
   quit. On macOS the status bar shows "Update X available" and the button opens the
   release page. The process log (stderr, visible when launched from a terminal) prints `update mode: auto` or `notify`.
5. To test the first release itself there is no earlier version to update from, so
   confirm the draft's installers launch and that Settings reports "You are up to date"
   once published.

## TODO: Apple Developer ID certificate

Deferred by decision; tracked in `ROADMAP.md` under "Decisions pending".

- **Unlocks:** macOS auto-update; no Gatekeeper warning for people who download the app;
  no keychain prompt on every local build.
- **Costs:** an Apple Developer Program membership, 99 USD per year.
- **To adopt it:** export the Developer ID Application certificate as a `.p12`, add its
  base64 as the repository secret `MAC_CSC_LINK` and its password as
  `MAC_CSC_KEY_PASSWORD`. The workflow already passes both through and switches
  `CSC_IDENTITY_AUTO_DISCOVERY` on when `MAC_CSC_LINK` exists. For Gatekeeper to
  stop warning, notarisation is also needed (`mac.notarize: true` plus
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets in the macOS step);
  that part is not wired yet.
