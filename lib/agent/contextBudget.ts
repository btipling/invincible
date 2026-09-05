/**
 * Fold-budget math (plan #944, source #551 — A3). Pure, server/client-safe,
 * no I/O, never throws.
 *
 * Core rule (#551): the fold budget = `contextWindow(model) − reserveTokens`,
 * in tokens. Char slicing survives only as a last-resort transport backstop,
 * never the product rule.
 *
 * Token measurement: at the seed/fold boundary there is no provider count for
 * the not-yet-assembled context (a `UsageSummary` is a per-completion count
 * captured after a round, not a pre-send measurement), so the budget trims
 * with the documented estimator (`CONTEXT_CHARS_PER_TOKEN` chars/token).
 * Provider token counts are the occupancy-meter signal (#556), never this
 * budget's input. No Wasm tokenizer.
 */
import {
  CONTEXT_CHARS_PER_TOKEN,
  CONTEXT_RESERVE_FRACTION,
  CONTEXT_RESERVE_MIN_TOKENS,
} from '../sessionCloudCaps';
import { contextWindowForModel } from './contextWindow';

/**
 * Estimate tokens for a text: `ceil(chars / CONTEXT_CHARS_PER_TOKEN)`. O(chars),
 * documented ratio, no tokenizer. Empty/whitespace-only → 0.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN);
}

/**
 * The fold budget for a model: `contextWindow(model) − reserveTokens`, where
 * the reserve follows the Pi-style rule
 * `floor(max(CONTEXT_RESERVE_MIN_TOKENS, CONTEXT_RESERVE_FRACTION × window))`
 * — covers the completion plus system/tool overhead. The window is the joined
 * catalog value when published, else the conservative default (never a lie).
 * Always ≥ 1: a tiny window still leaves a minimal budget.
 */
export function foldBudgetTokens(
  windowMap: ReadonlyMap<string, number> | undefined,
  modelId: string,
): number {
  const window = contextWindowForModel(windowMap, modelId);
  const fractional = Math.floor(CONTEXT_RESERVE_FRACTION * window);
  const reserve = Math.max(CONTEXT_RESERVE_MIN_TOKENS, fractional);
  return Math.max(1, window - reserve);
}
