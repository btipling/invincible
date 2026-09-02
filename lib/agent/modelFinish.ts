/**
 * Provider `finishReason` classification for one model round.
 *
 * `content-filter` and `error` are irrecoverable provider refusals — the turn
 * ends as SSE `error`. `length` is the provider output-token cap: the model
 * already produced text, so the turn completes (`done`) with that partial
 * answer. A cap is not a failed turn.
 *
 * There is no `isTruncatedFinish`. That classifier treated `length` as a
 * turn-end; turn-end uses {@link isProviderRefusalFinish} only.
 */

export const OUTPUT_TRUNCATED_ERROR = 'output truncated';
export const CONTENT_FILTER_ERROR = 'content filtered';
export const MODEL_FINISH_ERROR = 'model error';
export const STEP_BUDGET_ERROR = 'step budget exhausted';
/** Wall-clock cap error — SSE `error` copy AND the step-abort sentinel string (plan #923). */
export const TURN_WALL_CLOCK_ERROR = 'turn wall clock exceeded';

/** Model-visible wrap-up after the workflow step cap. Not canvas copy. */
export const STEP_BUDGET_WRAPUP =
  'Error: step budget exhausted. The harness stopped this turn at the workflow step cap (each model round, tool call, and persist counts as one step). Do not call tools. Briefly tell the user what you completed and what remains.';

/** System for the tools-off cap wrap-up. Must not be DEFAULT_AGENT_SYSTEM. */
export const STEP_BUDGET_WRAPUP_SYSTEM =
  'You are the Invincible coding agent. This wrap-up round has no tools. Do not call tools. Briefly tell the user what you completed this turn and what remains. Be concise.';

/**
 * Model-visible wrap-up after the 1-hour wall-clock cap (plan #923). Distinct
 * copy from `STEP_BUDGET_WRAPUP` — the model must say "hit the 1-hour cap", not
 * "step budget". Tools off. Not canvas copy.
 */
export const TURN_WALL_CLOCK_WRAPUP =
  'Error: turn wall clock exceeded. The harness stopped this turn at the 1-hour wall-clock cap. Do not call tools. Briefly tell the user what you completed and what remains.';

/** System for the tools-off wall-clock wrap-up. Distinct from the step-budget one. */
export const TURN_WALL_CLOCK_WRAPUP_SYSTEM =
  'You are the Invincible coding agent. This wrap-up round has no tools. Do not call tools. The previous turn was stopped at the 1-hour wall-clock cap. Briefly tell the user what you completed this turn and what remains. Be concise.';

/** Provider refused or crashed — the only finishReasons that fail the turn. */
export function isProviderRefusalFinish(reason: string | undefined): boolean {
  return reason === 'content-filter' || reason === 'error';
}

/**
 * SSE / canvas error for a provider-refusal `finishReason`.
 * `length` is not a refusal (callers must not fail the turn on it).
 */
export function truncatedFinishError(reason: string | undefined): string {
  if (reason === 'content-filter') return CONTENT_FILTER_ERROR;
  if (reason === 'error') return MODEL_FINISH_ERROR;
  return OUTPUT_TRUNCATED_ERROR;
}
