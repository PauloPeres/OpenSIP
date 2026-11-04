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
5. When it is green, open **Releases**. Read the `verify-draft` summary first: green means
   the run finished, not that the draft is complete. There is a **draft** `vX.Y.Z` holding
   the installers. Download and try at least one, read the notes, edit them if you want.
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
4. **verify-draft** checks that the draft holds `latest.yml`, `latest-mac.yml`,
   `latest-linux.yml` and a `.dmg`, `.zip`, `.exe`, `.AppImage` and `.deb`. It reports what
   is missing in the run summary and fails only if there is no draft or it is empty (see
   below).

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
line means no release has been published yet, so it should not appear now that v0.1.0 is
published.

## What the first release taught us

v0.1.0 was published on 4 November 2026. It did not go through the workflow cleanly, and
the next release will meet the same things.

- **GitHub did not allocate a macOS runner.** Across three attempts, each run was
  cancelled after exactly 15 minutes in the queue, with no runner assigned and no step
  started. The same job had succeeded in 1m35s the day before, so this was capacity on
  GitHub's side, not configuration. Ubuntu and Windows got runners within seconds in the
  same runs. The `timeout-minutes` values above do not help here: nothing had started.
- **The macOS binaries in v0.1.0 were built locally**, not in CI, and uploaded to the
  draft, using the same `electron-builder` command the workflow runs. This is not ideal: a
  locally built artifact is less reproducible than one built on a clean CI runner, and it
  depends on the state of one machine. The Windows and Linux binaries came from the workflow.
- **A trap when uploading by hand.** A local build names files with spaces
  (`Open SIP Phone-0.1.0-mac-arm64.dmg`), while `latest-mac.yml` references hyphenated
  names (`Open-SIP-Phone-0.1.0-mac-arm64.dmg`). Uploaded unrenamed, the files would sit in
  the release and the updater would fetch URLs that return 404: a silent failure. If you
  repeat a manual upload, rename the files first, then check that every URL in each
  `latest*.yml` resolves to a real asset. For v0.1.0 every download URL was checked and
  returned HTTP 200.

### Two behaviours of the workflow, and why they exist

Both came out of v0.1.0 and both are now handled in `.github/workflows/release.yml`.

1. **Deleting a tag does not start a run.** A `v*` tag trigger fires for deletion as well
   as creation, so recycling a tag (delete it, push it again on a new commit) used to start
   two runs for one commit; during v0.1.0 one had to be cancelled by hand. The `check` job
   now skips itself when `github.event.deleted` is `true`. Every other job needs `check`,
   so the whole run is skipped. The comparison goes through `format()` so it also holds on
   a manual run, where that value is absent. Prefer a new version over recycling a tag
   anyway, and check **Actions** after any tag change.
2. **`verify-draft` reports; it does not block.** It used to fail the run when any artifact
   was missing, so an outage such as the missing macOS runner above turned a release that
   was ready for two of three platforms into a red run. Nothing reaches users until you
   publish the draft, so a missing artifact is information for that decision. The job now
   runs whenever `check` and `quality` succeeded and the run was not cancelled, even if
   `build` failed on one platform. For each of the eight expected assets it writes a
   warning when missing, and it writes a table of found and missing to the run summary,
   followed by a verdict: either the draft is complete, or which platforms are missing and
   that publishing would ship a release those users cannot install or update to. It names
   the update manifests specifically: a draft without `latest-mac.yml` silently breaks
   updates for every existing macOS install, which is worse than a missing installer.

   **Still fails the run:** no draft for the version, or a draft with no assets at all.
   That is not one platform degraded; nothing was produced. A failed `check` or `quality`
   also stops the run before any build, as before.

   A green `verify-draft` therefore no longer means the draft is complete. Read the run
   summary before you publish.

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

1. Draft complete: the `verify-draft` run summary says "Complete" (green alone is not enough, since the job reports missing assets without failing); the asset list matches the table above.
2. Metadata sane: `latest*.yml` open and list the right `version`.
3. Before publishing, install the previous version, then publish the new one.
4. Launch the old version (a packaged build; dev builds never check). On
   Windows/Linux the Settings text moves to "downloaded" and the new version installs on
   quit. On macOS the status bar shows "Update X available" and the button opens the
   release page. The process log (stderr, visible when launched from a terminal) prints `update mode: auto` or `notify`.
5. v0.1.0 had no earlier version to update from, so the only check available was that
   its installers launch and that Settings reports "You are up to date". From the next
   release on, v0.1.0 is the version to update from, so steps 3 and 4 apply in full.

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
