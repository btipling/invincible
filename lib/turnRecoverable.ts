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

const RECOVERABLE_NEEDLES = [
  'transcript segment write failed',
  'object byte ceiling',
  'session_store_unavailable',
] as const;

/**
 * Case-insensitive substring allowlist. Does **not** match isolated `oversize`,
 * Stop, content-filter, truncated, model error, or step-budget strings.
 */
export function isRecoverableBookkeepingError(error: string): boolean {
  const s = (error ?? '').toLowerCase();
  if (!s) return false;
  return RECOVERABLE_NEEDLES.some((n) => s.includes(n));
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
};

/**
 * After `runHarnessTurn` give-up: one `'continue'` POST iff classified
 * recoverable + `canAutoContinue` + envelope not running + flag unset.
 */
export function shouldAutoContinueAfterGiveUp(input: AutoContinueGiveUpInput): boolean {
  if (input.resultOk) return false;
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
