/**
 * Provider `finishReason` classification for one model round.
 *
 * `length` is the provider output-token cap (not an HTTP error, not a product
 * maxTokens we set). Folding it as “model finished” is a lie.
 */

export const OUTPUT_TRUNCATED_ERROR = 'output truncated';
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
