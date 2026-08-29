/**
 * Provider `finishReason` classification for one model round.
 *
 * `length` is the provider output-token cap (not an HTTP error, not a product
 * maxTokens we set). Folding it as “model finished” is a lie.
 */

export const OUTPUT_TRUNCATED_ERROR = 'output truncated';
export const STEP_BUDGET_ERROR = 'step budget exhausted';

export function isTruncatedFinish(reason: string | undefined): boolean {
  return reason === 'length' || reason === 'content-filter' || reason === 'error';
}
