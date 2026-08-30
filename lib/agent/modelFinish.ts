/**
 * Provider `finishReason` classification for one model round.
 *
 * `content-filter` and `error` are irrecoverable provider refusals — the turn
 * ends as SSE `error`. `length` is the provider output-token cap: the model
 * already produced text, so the turn completes (`done`) with that partial
 * answer. A cap is not a failed turn.
 */

export const OUTPUT_TRUNCATED_ERROR = 'output truncated';
export const CONTENT_FILTER_ERROR = 'content filtered';
export const MODEL_FINISH_ERROR = 'model error';
export const STEP_BUDGET_ERROR = 'step budget exhausted';

/** Model-visible wrap-up after the workflow step cap. Not canvas copy. */
export const STEP_BUDGET_WRAPUP =
  'Error: step budget exhausted. The harness stopped this turn at the workflow step cap (each model round, tool call, and persist counts as one step). Do not call tools. Briefly tell the user what you completed and what remains.';

/** System for the tools-off cap wrap-up. Must not be DEFAULT_AGENT_SYSTEM. */
export const STEP_BUDGET_WRAPUP_SYSTEM =
  'You are the Invincible coding agent. This wrap-up round has no tools. Do not call tools. Briefly tell the user what you completed this turn and what remains. Be concise.';

export function isTruncatedFinish(reason: string | undefined): boolean {
  return reason === 'length' || reason === 'content-filter' || reason === 'error';
}

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