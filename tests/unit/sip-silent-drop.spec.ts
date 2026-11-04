import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_AGENT, USER_AGENT_PRESETS, isSilentAfterTrying, presetToSetting, silentFilterHintKey } from '../../src/core/sip';
import type { SetupEnd } from '../../src/core/sip';

const HINT = 'calls.endHint.silentFilter';

const timedOut = (provisionals: readonly number[], rest: Partial<SetupEnd> = {}): SetupEnd => ({
  direction: 'outbound',
  provisionals,
  finalStatus: undefined,
  timedOut: true,
  ...rest
});

describe('the silent-filter signature', () => {
  it('qualifies a 100 followed by nothing until our own guard ended the call', () => {
    expect(isSilentAfterTrying(timedOut([100]))).toBe(true);
  });

  it('qualifies a stream of repeated 100s just the same', () => {
    expect(isSilentAfterTrying(timedOut([100, 100, 100]))).toBe(true);
  });

  it('does not qualify 100 then 180 then silence: the far end was reached', () => {
    expect(isSilentAfterTrying(timedOut([100, 180]))).toBe(false);
  });

  it('does not qualify 183 or 181 progress either', () => {
    expect(isSilentAfterTrying(timedOut([100, 183]))).toBe(false);
    expect(isSilentAfterTrying(timedOut([100, 181]))).toBe(false);
  });

  it('does not qualify 100 then a 4xx: the server answered, it did not go quiet', () => {
    expect(isSilentAfterTrying(timedOut([100], { finalStatus: 404, timedOut: false }))).toBe(false);
    expect(isSilentAfterTrying(timedOut([100], { finalStatus: 404 }))).toBe(false);
  });

  it('does not qualify a call that never got a 100 (plain loss, not a server that accepted the request)', () => {
    expect(isSilentAfterTrying(timedOut([]))).toBe(false);
  });

  it('does not qualify a call that ended some other way than our guard', () => {
    expect(isSilentAfterTrying(timedOut([100], { timedOut: false }))).toBe(false);
  });

  it('never qualifies an inbound call', () => {
    expect(isSilentAfterTrying(timedOut([100], { direction: 'inbound' }))).toBe(false);
  });
});

describe('the hint offered for it', () => {
  it('is offered while the User-Agent is still the default, blank or spelled out', () => {
    expect(silentFilterHintKey(timedOut([100]), '')).toBe(HINT);
    expect(silentFilterHintKey(timedOut([100]), DEFAULT_USER_AGENT)).toBe(HINT);
  });

  it('is not repeated once the user has changed the User-Agent', () => {
    expect(silentFilterHintKey(timedOut([100]), 'OpenSIPPhone')).toBeUndefined();
    expect(silentFilterHintKey(timedOut([100]), 'Z 5.6.16')).toBeUndefined();
  });

  it('counts choosing any preset as having tried it', () => {
    USER_AGENT_PRESETS.map(presetToSetting).filter((setting) => setting !== '').forEach((setting) => {
      expect(silentFilterHintKey(timedOut([100]), setting)).toBeUndefined();
    });
  });

  it('is not offered for a call that does not carry the signature', () => {
    expect(silentFilterHintKey(timedOut([100, 180]), '')).toBeUndefined();
    expect(silentFilterHintKey(timedOut([100], { direction: 'inbound' }), '')).toBeUndefined();
  });
});
