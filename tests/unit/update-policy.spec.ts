import { describe, expect, it } from 'vitest';
import { decideUpdateMode, parseSignature } from '../../src/main/update-policy';

const ADHOC = 'Identifier=com.opensip.app\nSignature=adhoc\nTeamIdentifier=not set\n';
const DEVELOPER_ID = 'Identifier=com.opensip.app\nAuthority=Developer ID Application: X (ABCDE12345)\nTeamIdentifier=ABCDE12345\n';

describe('parseSignature', () => {
  it('recognises an ad-hoc signature', () => expect(parseSignature(ADHOC)).toBe('adhoc'));
  it('recognises a signature that carries a team', () => expect(parseSignature(DEVELOPER_ID)).toBe('identified'));
  it('treats a missing team as unknown', () => expect(parseSignature('TeamIdentifier=not set\n')).toBe('unknown'));
  it('treats unsigned or failed codesign output as unknown', () => {
    expect(parseSignature('')).toBe('unknown');
    expect(parseSignature('opensip.app: code object is not signed at all')).toBe('unknown');
  });
});

describe('decideUpdateMode', () => {
  it('notifies only on macOS without a Developer ID', () => {
    expect(decideUpdateMode('darwin', 'adhoc')).toBe('notify');
    expect(decideUpdateMode('darwin', 'unknown')).toBe('notify');
  });
  it('updates by itself on macOS once a real identity signs the build', () => {
    expect(decideUpdateMode('darwin', parseSignature(DEVELOPER_ID))).toBe('auto');
  });
  it('updates by itself on Windows and Linux whatever the signature', () => {
    expect(decideUpdateMode('win32', 'unknown')).toBe('auto');
    expect(decideUpdateMode('linux', 'adhoc')).toBe('auto');
  });
});
