/**
 * Plan #887 — client-safe classifier for one host auto-continue after a
 * recoverable bookkeeping give-up. No I/O, no secrets, not a backend route.
 *
 * Allowlist only. Same-POST SSE retry (5 / 1 after paint) is a different path
 * (`docs/agent-stream.md`). This is a **new turn** with history fold.
 */
import { canAutoContinue } from './harnessCanAutoContinue';
import type { TurnEndKind } from './harnessChat';
import type { TurnStatus } from './sessionCloudCaps';

/** Literal prompt for the auto-continue POST (not a User row). */
export const AUTO_CONTINUE_PROMPT = 'continue' as const;

/** NEW cap — one auto-continue per give-up; clears on the next operator submit. */
export const AUTO_CONTINUE_PER_GIVE_UP = 1 as const;

/**
 * Space-form needles. `isRecoverableBookkeepingError` folds `_` → space so the
 * production `error` field (`session store unavailable`) and the `code` token
 * (`SESSION_STORE_UNAVAILABLE`) match the same row.
 *
 * `session store unavailable` is **belt-and-suspenders**, not a live
 * `runHarnessTurn` `result.error` on POST `/api/turns`:
 *   - tenant fail → `Unable to resolve tenant for the durable turn.` (route
 *     swallows tenant `code`/`error`)
 *   - store resolve fail → fail-open 200 (turn still starts)
 *   - attach 503 → `Unable to attach to run stream (store unavailable).`
 *     (D18 keep-`running`; the running gate would skip even if it matched)
 * Those turn-path copies are intentionally **not** needles (C15 / D18), not
 * missed allowlist rows. Persist `{ok:false}` after #885 is also non-terminal;
 * `transcript segment write failed` / `object byte ceiling` fire only if that
 * overlay regresses (or a throw concatenates the sessions phrase / code token).
 *
 * Do **not** match isolated `oversize`, Stop, content-filter, truncated, model
 * error, step-budget, or the attach-503 copy above.
 */
const RECOVERABLE_NEEDLES = [
  'transcript segment write failed',
  'object byte ceiling',
  'session store unavailable',
] as const;

/**
 * Case-insensitive substring allowlist. Underscores fold to spaces so JSON
 * `code` tokens and human `error` fields hit the same needle.
 */
export function isRecoverableBookkeepingError(error: string): boolean {
  const s = (error ?? '').toLowerCase().replace(/_/g, ' ');
  if (!s) return false;
  return RECOVERABLE_NEEDLES.some((n) => s.includes(n));
}

/**
 * Plan #887 adversarial — `#844` mint-bind remaps `sess_*` → UUID in
 * `runPrompt` `finally` *after* the one-shot flag is keyed. Move the bit so
 * cap 1 survives the rewrite (the auto-continue POST uses the UUID).
 */
export function migrateAutoContinueFlag(
  flags: Map<string, boolean>,
  fromId: string,
  toId: string,
): void {
  if (!fromId || !toId || fromId === toId) return;
  if (flags.get(fromId) === true) {
    flags.set(toId, true);
    flags.delete(fromId);
  }
}

export type AutoContinueGiveUpInput = {
  resultOk: boolean;
  kind: TurnEndKind;
  error: string;
  turnStatus?: TurnStatus;
  inflight: boolean;
  queuedCount: number;
  hasPendingSubmit: boolean;
  didAutoContinue: boolean;
  /** Send-while-running remapped re-POST wins (host `shouldRepostAttachFollowUp`). */
  repostFollowUp: boolean;
};

/**
 * After `runHarnessTurn` give-up: one `'continue'` POST iff classified
 * recoverable + `canAutoContinue` + envelope not running + flag unset +
 * not a remapped attach follow-up.
 */
export function shouldAutoContinueAfterGiveUp(input: AutoContinueGiveUpInput): boolean {
  if (input.resultOk) return false;
  if (input.repostFollowUp) return false;
  if (input.kind !== 'error') return false;
  if (!isRecoverableBookkeepingError(input.error)) return false;
  if (input.turnStatus === 'running') return false;
  if (input.didAutoContinue) return false;
  return canAutoContinue({
    inflight: input.inflight,
    queuedCount: input.queuedCount,
    hasPendingSubmit: input.hasPendingSubmit,
  });
}
