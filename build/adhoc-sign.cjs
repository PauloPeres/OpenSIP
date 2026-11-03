// electron-builder `mac.sign` hook (see electron-builder.yml).
//
// electron-builder 25 skips macOS signing entirely when no Developer ID
// certificate is found, leaving only the linker's signature on the stock
// Electron binary (Identifier=Electron, Info.plist not bound). macOS then
// cannot tie the bundle to com.opensip.app, which breaks the Dock/TCC icon.
//
// This hook delegates to @electron/osx-sign (which signs nested helpers and
// frameworks inside-out) but falls back to an ad-hoc identity ("-") when no
// real identity was discovered, so it works for anyone who clones the repo.
// If a real certificate is available, electron-builder passes it in opts.identity
// and it is used unchanged.
const { signAsync } = require('@electron/osx-sign')

module.exports = async function adhocSign(opts) {
  await signAsync({
    ...opts,
    identity: opts.identity || '-',
    identityValidation: false,
  })
}
