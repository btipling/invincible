/**
 * Plan #812 (backend-agents D18) — decide what a DOM-host "leave the turn"
 * operation should do: detach vs close-vs-abort vs noop.
 *
 * A durable detach must close THIS reader without riding
 * `abort()` → `signal.aborted` → `classifyTurnFailure` `'stop'` → persist-clear
 * of `turnRunId`/`turnStatus` (adversarial #844). Stop/Esc is a real **cancel**.
 *
 * Reader close: we still `AbortController.abort(DETACH_ABORT_REASON)` so the
 * fetch does not leak (zombie SSE). `classifyTurnFailure` treats that reason as
 * `'detach'`, not `'stop'`, and the fail fold keeps `turnRunId` + `running`.
 *
 * Pure + unit-testable — no React, no I/O, no caps introduced/changed.
 */
import type { TurnStatus } from './sessionCloudCaps';

/** `AbortController.abort` reason for a durable detach (not a user Stop). */
export const DETACH_ABORT_REASON = 'detach';

/** Decision a detach/cancel site should act on. */
export type DetachDecision = 'detach' | 'detach-close' | 'noop' | 'cancel';

/** Inputs `decideDetach` needs to pick a decision. */
export interface DetachTurnInput {
  /**
   * True when the caller is a real operator cancel (Stop / Esc) — NEVER a
   * detach. Always wins: a real abort is never routed through detach.
   */
  cancel: boolean;
  /** True while a turn is in flight (`inflightRef.current`). */
  inflight: boolean;
  /**
   * True when this tab's in-flight reader is the durable `/api/turns` path
   * (D17 production). Headers may not have folded `turnRunId`/`running` yet;
   * the in-flight durable reader is still a detach, not a stop-fold.
   */
  durablePath?: boolean;
  /** Session-sticky durable run id (`meta.turnRunId`), if any. */
  turnRunId?: string;
  /** Session-sticky turn status (`meta.turnStatus`), if any. */
  turnStatus?: TurnStatus;
}

/**
 * Decide the action for a detach/cancel site. See the D18 contract:
 *
 * | Input | Decision |
 * |-------|----------|
 * | Stop / Esc (`cancel`) | `cancel` |
 * | Durable run present (`turnRunId` + running/cancelling) | `detach` |
 * | In-flight `/api/turns` reader (`durablePath`) | `detach` |
 * | In-flight turn with no durable run id | `detach-close` |
 * | Idle / no run id | `noop` |
 */
export function decideDetach(input: DetachTurnInput): DetachDecision {
  // Real operator cancel — never routed through detach.
  if (input.cancel) return 'cancel';
  // Durable run present + live → detach: close the reader, keep the run.
  if (
    input.turnRunId !== undefined &&
    (input.turnStatus === 'running' || input.turnStatus === 'cancelling')
  ) {
    return 'detach';
  }
  // Live D17 tab before headers fold running onto the session (adversarial #844).
  if (input.inflight && input.durablePath) return 'detach';
  // In-flight turn with no durable run id → close is fine (nothing to preserve).
  if (input.inflight) return 'detach-close';
  // Idle / no active turn → nothing to do.
  return 'noop';
}

/**
 * Host-side boolean shorthands so callers don't re-derive the branch.
 * `decideDetach` is the single source of truth; these are convenience
 * predicates for the wiring (keep in sync with the contract above).
 */
export function shouldAbortReader(decision: DetachDecision): boolean {
  // Close the fetch for detach / detach-close / cancel. A noop has nothing
  // to abort. Durable detach uses DETACH_ABORT_REASON (see abortReasonFor).
  return decision === 'detach' || decision === 'detach-close' || decision === 'cancel';
}

/** Reason to pass to `AbortController.abort`, or `undefined` for a normal stop. */
export function abortReasonFor(decision: DetachDecision): string | undefined {
  return decision === 'detach' ? DETACH_ABORT_REASON : undefined;
}

/** True when this abort is a durable detach, not a user Stop. */
export function isDetachAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true && signal.reason === DETACH_ABORT_REASON;
}
