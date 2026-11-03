import type { CallView } from '../../../shared/api';

/** The engine may add these fields to CallView; until it does, the UI derives them from the state. */
export type ProgressedView = CallView & { readonly progress?: string; readonly endReasonKey?: string };

const SETUP_TIMEOUT = 'calls.endReason.setupTimeout'; // i18n-exempt: translation key
const STAGES: readonly string[] = ['trying', 'waiting', 'ringing', 'connecting', 'active', 'ended'];
const PENDING: readonly string[] = ['trying', 'waiting', 'ringing', 'connecting'];
const PROGRESS_PREFIX = 'calls.progress.'; // i18n-exempt: translation key prefix

function derivedStage(view: CallView): string | null {
  const { state, direction } = view.call;
  if (state === 'ringing') return direction === 'outbound' ? 'ringing' : null;
  if (state === 'connecting') return direction === 'outbound' ? 'trying' : 'connecting';
  if (state === 'active' || state === 'ended') return state;
  return null;
}

/** The engine sends a full key (calls.progress.x); a bare stage name is accepted too. */
function stageOf(view: ProgressedView): string | null {
  const given = view.progress?.startsWith(PROGRESS_PREFIX) ? view.progress.slice(PROGRESS_PREFIX.length) : view.progress;
  return given !== undefined && STAGES.includes(given) ? given : derivedStage(view);
}

/** The i18n key of the plain-language status for a call, or null when the state label says it all. */
export function progressKey(view: ProgressedView): string | null {
  const reason = endReasonKey(view);
  if (reason !== null) return reason;
  const stage = stageOf(view);
  return stage === null ? null : `${PROGRESS_PREFIX}${stage}`;
}

/** True while the server has answered with a provisional response and then gone quiet. */
export function isWaiting(view: ProgressedView): boolean {
  return stageOf(view) === 'waiting';
}

/** The call was abandoned because the server never produced a final answer. */
export function isSetupTimeout(view: ProgressedView): boolean {
  return view.endReasonKey === SETUP_TIMEOUT;
}

/** Any reason the engine names is shown; one this build does not know is displayed as its key, not hidden. */
export function endReasonKey(view: ProgressedView): string | null {
  const key = view.endReasonKey;
  return key === undefined || key === '' ? null : key;
}

/** True while the call is still being set up, so the status can animate. */
export function isPending(view: ProgressedView): boolean {
  const stage = stageOf(view);
  return stage !== null && PENDING.includes(stage);
}
