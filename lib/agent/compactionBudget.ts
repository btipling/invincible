/**
 * Compaction trigger estimate (plan #948, source #552 — A4 compaction phase
 * 1). Pure, server/client-safe, no I/O, never throws.
 *
 * `shouldCompact` is the phase-1 pure helper the route (phase 3, #950) will
 * call on the **pre-trim** seeded projection (parent #947 review-note 1
 * lock: the trigger is evaluated BEFORE `trimModelMessagesToBudget`, because
 * a trimmed seed always fits and would mask the overflow compaction
 * resolves). The budget passed in is the #944 `foldBudgetTokens` result for
 * the selected model; when the window is unknown #944 fails open to the
 * conservative default budget — compaction inherits that honesty and does
 * not compact on a lie (the caller simply passes that default; a tiny
 * estimate stays under it and returns false).
 *
 * Trigger line = `budgetTokens` (parent #947 Goal 1 / plan #948 Testing row
 * 5 / adversarial #953). `foldBudgetTokens` already subtracted the Pi
 * completion reserve (`CONTEXT_RESERVE_MIN_TOKENS` = 16 384, same value as
 * `COMPACTION_RESERVE_TOKENS`). Subtracting that cap again zeroed the
 * trigger on every ~32k-or-smaller window — the models that overflow first.
 * The estimator is REUSED from #944's `contextBudget.estimateTokens`
 * (chars/4 over the serialized projection) — never a second estimator.
 */
import { estimateTokens } from './contextBudget';
import type { ModelMessageRow } from './modelMessages';

/**
 * True when the pre-trim seeded projection's estimated prompt tokens exceed
 * `budgetTokens` (the #944 fold budget). Empty / zero-row projections →
 * false (nothing to compact; honest no). A non-positive `budgetTokens` →
 * false (fail-open: a degenerate budget never compacts). Pure, never throws.
 */
export function shouldCompact(
  rows: ReadonlyArray<ModelMessageRow>,
  budgetTokens: number,
  opts?: {
    /** Override the estimator ratio (tests). Defaults to CONTEXT_CHARS_PER_TOKEN. */
    charsPerToken?: number;
  },
): boolean {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return false;
  const n = rows.length;
  if (n === 0) return false;
  const json = JSON.stringify(rows);
  const estimated =
    opts?.charsPerToken && opts.charsPerToken > 0
      ? Math.ceil(json.length / opts.charsPerToken)
      : estimateTokens(json);
  return estimated > budgetTokens;
}
