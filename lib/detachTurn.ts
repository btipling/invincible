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

/**
 * What the host should do with a turn snapshot after a leave-turn site
 * (adversarial #844 re-review).
 *
 * | Input | Action |
 * |-------|--------|
 * | Clear/remove discarded the started id | `drop` — never PUT (LWW upsert would resurrect) |
 * | Still on this turn (epoch match) | `live` — writeLocal + put as today |
 * | Detached + running + turnRunId | `preserve` — PUT onto `preserveTargetId` (pending mint UUID, else startedId); never clobber a switched live session |
 * | Detached without a durable running id | `drop` — skip PUT so we cannot omit-clear C14d |
 */
export type DetachPersistAction = 'live' | 'preserve' | 'drop';

export interface DetachPersistInput {
  /** True when this tab left the turn (`turnEpochRef` advanced). */
  detached: boolean;
  /**
   * True when the started session was Clear/remove'd. A preserve PUT would
   * LWW-upsert the deleted row (adversarial #844 Major).
   */
  discarded: boolean;
  /** Session-sticky durable run id on the snapshot being persisted. */
  turnRunId?: string;
  /** Session-sticky turn status on the snapshot being persisted. */
  turnStatus?: TurnStatus;
}

export function decideDetachPersist(input: DetachPersistInput): DetachPersistAction {
  if (input.discarded) return 'drop';
  if (!input.detached) return 'live';
  if (input.turnRunId && input.turnStatus === 'running') return 'preserve';
  return 'drop';
}

/**
 * Id a preserve PUT/writeLocal should target (adversarial #844 mint-bind).
 * First-turn boot mint is deferred (`pendingMintBindRef`) until the turn ends;
 * SPA-nav unmount must land the envelope on that UUID, not local `sess_*`.
 */
export function preserveTargetId(
  startedId: string,
  pendingMintId?: string | null,
): string {
  const mint = pendingMintId?.trim();
  return mint ? mint : startedId;
}

/**
 * Put surface captured from `repoRef` at `runPrompt` start so unmount cleanup
 * (`repoRef.current = null`) cannot drop a preserve PUT (adversarial #844).
 */
export type DetachPersistRepo<T extends { id: string } = { id: string }> = {
  put(id: string, snapshot: T): void;
};

/**
 * PUT a preserve snapshot onto `preserveTargetId`. Pass the **captured** repo
 * object, not `repoRef.current`: abort microtasks run AFTER the boot-effect
 * cleanup nulls the ref.
 */
export function putPreservedTurn<T extends { id: string }>(
  repo: DetachPersistRepo<T> | null | undefined,
  snapshot: T,
  startedId: string,
  pendingMintId?: string | null,
): { targetId: string; preserved: T } {
  const targetId = preserveTargetId(startedId, pendingMintId);
  const preserved = { ...snapshot, id: targetId };
  repo?.put(targetId, preserved);
  return { targetId, preserved };
}

/**
 * Whether #430 mint bind (`sess_*` → server UUID) should rewrite local/cloud
 * identity after this turn (adversarial #844).
 *
 * | Input | Apply? |
 * |-------|--------|
 * | Still on startedId, not discarded, not Switch | yes (live completion or unmount) |
 * | Switch in flight (`sessionRef` still startedId until `repo.get`) | no — would abort Switch's generation token |
 * | Clear discarded startedId | no — would upsert the deleted row onto the mint UUID |
 * | Session already switched/New'd (`sessionId !== startedId`) | no |
 */
export function shouldApplyMintBind(input: {
  sessionId: string;
  startedId: string;
  discarded: boolean;
  switchInFlight: boolean;
}): boolean {
  return (
    input.sessionId === input.startedId &&
    !input.discarded &&
    !input.switchInFlight
  );
}

/**
 * Same-tab durable detach must not light ember `hostNote` (adversarial #853).
 * Leave-site D18 already skips the note via epoch mismatch. EOF detach is
 * same-epoch + `{ ok: false }` + `turnStatus: 'running'` — canvas Ready, run
 * still live. A host error string would lie that the turn failed.
 *
 * `running` is the persist contract for detach (D18 fold). Other fail
 * outcomes write `completed` (or leave a leftover terminal status) and
 * still surface the note.
 */
export function shouldSetHostTurnNote(turnStatus?: TurnStatus): boolean {
  return turnStatus !== 'running';
}

/**
 * Clear host Busy chrome this tick (Stop poll, and optionally D18 detach).
 * Does **not** bump turn epoch and does **not** choose an abort reason —
 * Stop must still land the late stop-fold persist.
 */
export type BusyViewportHooks = {
  inflightRef: { current: boolean };
  setBusy: (busy: boolean) => void;
  setQueuePromoteAllowed: (allowed: boolean) => void;
  setLifecycleReady: () => void;
};

export function releaseBusyViewport(hooks: BusyViewportHooks): void {
  hooks.inflightRef.current = false;
  hooks.setBusy(false);
  hooks.setQueuePromoteAllowed(false);
  hooks.setLifecycleReady();
}

// ── Plan #816 (G22) — Stop/Esc server-cancel fold planner ──

/** Outcome of the G22 cancel POST, mapped 1:1 from `lib/turnApi.cancelTurn`. */
export type CancelPostOutcome =
  | { kind: 'accepted' }
  | { kind: 'terminal' }
  | { kind: 'gone' }
  | { kind: 'failed' };

/**
 * What the host Stop fold should do with the session after one Stop/Esc tick
 * (plan #816 Host Stop fold + Cancel race table).
 *
 * | Input | Fold |
 * |-------|------|
 * | No live `turnRunId` (legacy `/api/agent` path) | `legacy-clear` — old `turnRunId: undefined` + `completed` fold |
 * | Live run + cancel accepted | `cancelling` — KEEP `turnRunId`, fold `turnStatus: 'cancelling'` |
 * | Cancel POST failed (429/5xx/network) | `keep-running` — keep `turnRunId` + `running`, paint a soft note |
 * | Run terminal (409) or gone (404) | `clear-terminal` — clear `turnRunId` + fold `completed` (orphan-unstick) |
 */
export type StopFoldAction =
  | { kind: 'legacy-clear' }
  | { kind: 'cancelling' }
  | { kind: 'keep-running' }
  | { kind: 'clear-terminal' };

/**
 * Fold the session-side Stop decision BEFORE knowing the cancel POST outcome.
 * Only the durable path (live `turnRunId` + `running`) routes to the server
 * cancel; everything else keeps today's legacy clear fold.
 */
export function decideStopFoldPre(input: {
  turnRunId?: string;
  turnStatus?: TurnStatus;
}): Extract<StopFoldAction, { kind: 'legacy-clear' | 'cancelling' }> {
  if (input.turnRunId !== undefined && input.turnStatus === 'running') {
    return { kind: 'cancelling' };
  }
  return { kind: 'legacy-clear' };
}

/**
 * Fold the session-side Stop decision AFTER the cancel POST resolves
 * (plan #816 Cancel race & failure semantics). A `cancelling` pre-fold is
 * re-resolved by the server truth; `legacy-clear` never reaches here.
 */
export function decideStopFoldPost(input: {
  pre: Extract<StopFoldAction, { kind: 'legacy-clear' | 'cancelling' }>;
  outcome: CancelPostOutcome;
}): StopFoldAction {
  if (input.pre.kind === 'legacy-clear') return { kind: 'legacy-clear' };
  switch (input.outcome.kind) {
    case 'accepted':
      return { kind: 'cancelling' };
    case 'terminal':
    case 'gone':
      return { kind: 'clear-terminal' };
    case 'failed':
      return { kind: 'keep-running' };
  }
}

/**
 * True when a session already carries `turnStatus: 'cancelling'` for this
 * `turnRunId` — a second Stop/Esc must never re-POST the cancel (bounded,
 * once per run id).
 */
export function shouldSkipCancelPost(input: {
  turnRunId?: string;
  turnStatus?: TurnStatus;
}): boolean {
  return input.turnRunId !== undefined && input.turnStatus === 'cancelling';
}


