/**
 * Whether this install can replace itself. Squirrel.Mac verifies the code signature
 * before applying an update, and an ad-hoc signature does not satisfy it, so a macOS
 * build without a Developer ID must only notify. The answer is read from the running
 * app's own signature, so it flips to automatic on its own once a real certificate
 * signs the build; no flag has to be remembered.
 */
export type UpdateMode = 'auto' | 'notify';
export type SignatureKind = 'identified' | 'adhoc' | 'unknown';

const ADHOC_MARK = /^Signature=adhoc$/m;
const TEAM_ID = /^TeamIdentifier=(.+)$/m;
const NO_TEAM = 'not set';

/** Reads the text printed by `codesign -dv --verbose=4`. */
export function parseSignature(codesignOutput: string): SignatureKind {
  if (ADHOC_MARK.test(codesignOutput)) return 'adhoc';
  const team = TEAM_ID.exec(codesignOutput)?.[1]?.trim();
  return team !== undefined && team !== NO_TEAM ? 'identified' : 'unknown';
}

/** Only macOS is gated; anything but a positively identified signature there is treated as unable to self-update. */
export function decideUpdateMode(platform: NodeJS.Platform, signature: SignatureKind): UpdateMode {
  if (platform !== 'darwin') return 'auto';
  return signature === 'identified' ? 'auto' : 'notify';
}
