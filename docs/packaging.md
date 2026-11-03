# macOS packaging

## Signing

There is no paid Developer ID certificate, so `electron-builder.yml` sets
`mac.sign: build/adhoc-sign.cjs`. electron-builder 25 skips signing entirely when
no certificate is found (and always when `CSC_IDENTITY_AUTO_DISCOVERY=false`),
which leaves only the linker signature on the stock Electron binary:
`Identifier=Electron`, `Info.plist=not bound`. macOS derives the Dock and
Privacy & Security name/icon from the signature, so the app is not seen as
`com.opensip.app`.

The hook calls `@electron/osx-sign` (nested helpers and frameworks are signed
inside-out) with identity `-` (ad-hoc) unless electron-builder discovered a real
identity, which is then used unchanged. Works with `CSC_IDENTITY_AUTO_DISCOVERY`
set either way.

`hardenedRuntime` stays `true`. Ad-hoc signatures carry no Team ID, so with the
hardened runtime dyld refuses to load Electron Framework unless the entitlements
include `com.apple.security.cs.disable-library-validation` (present in
`build/entitlements.mac.plist`). Without that entitlement the app dies at launch.

## Verify

    npm run dist
    codesign -dv --verbose=4 dist/mac-arm64/OpenSIP.app   # Identifier=com.opensip.app, no "Info.plist=not bound"
    codesign --verify --deep --strict dist/mac-arm64/OpenSIP.app

## Stale icon / identity caches

    killall Dock Finder
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user
    sudo rm -rf /Library/Caches/com.apple.iconservices.store ; rm -rf ~/Library/Caches/com.apple.iconservices.store
    sudo find /private/var/folders -name com.apple.iconservices -exec rm -rf {} + 2>/dev/null
    killall iconservicesagent iconservicesd 2>/dev/null; killall Dock

Privacy & Security keeps the old entry for the old identity; remove it with
`tccutil reset Microphone com.opensip.app` and grant again.
