/**
 * Plan #812 (backend-agents D18) — decide what a DOM-host "leave the turn"
 * operation should do: detach vs close-vs-abort vs noop.
 *
 * Background: today every detach AND cancel rides `abortRef.current?.abort()`
 * → `signal.aborted` → `classifyTurnFailure` returns `'stop'` and folds the
 * turn as stopped (`lib/harnessChat.ts`), and the D17 failure fold clears the
 * durable `turnRunId` / marks `turnStatus` completed. For a **durable** turn
 * (`turnRunId` present + running/cancelling) that fold destroys the run the
 * client merely stopped reading, so the later E19 attach cannot reconnect.
 *
 * D18's rule: Stop/Esc is a real **cancel**; unmount / session switch / New /
 * logout is a **detach** — close this reader only, never classify the turn as
 * stopped, never clear the durable run id. `decideDetach` returns that decision
 * and the host wiring branches **before** any `AbortController.abort()`, so a
 * durable detach never rides the `'stop'` fold.
 *
 * Pure + unit-testable — no React, no I/O, no caps introduced/changed.
 */
import type { TurnStatus } from './sessionCloudCaps';

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
 * | Durable run present (`turnRunId` + `turnStatus` running/cancelling) | `detach` |
 * | In-flight turn with no durable run id | `detach-close` |
 * | Idle / no run id | `noop` |
 */
export function decideDetach(input: DetachTurnInput): DetachDecision {
  // Real operator cancel — never routed through detach.
  if (input.cancel) return 'cancel';
  // Durable run present + live → detach: abandon the reader only, keep the run.
  if (
    input.turnRunId !== undefined &&
    (input.turnStatus === 'running' || input.turnStatus === 'cancelling')
  ) {
    return 'detach';
  }
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
  // A durable detach never aborts (would ride the 'stop' fold and clear the
  // run). A noop has nothing to abort. detach-close (no durable run) and
  // cancel (real stop) both close the reader via abort.
  return decision === 'detach-close' || decision === 'cancel';
}
