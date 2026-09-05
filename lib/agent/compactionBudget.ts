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
 * The trigger line is `budgetTokens − COMPACTION_RESERVE_TOKENS` (the Pi
 * completion-reserve for the trigger only): a projection estimated ABOVE the
 * line compacts, at-or-below does not. The estimator is REUSED from #944's
 * `contextBudget.estimateTokens` (chars/4 over the serialized projection —
 * the same documented ratio the seed trim uses) — never a second estimator.
 */
import { COMPACTION_RESERVE_TOKENS } from '../sessionCloudCaps';
import { estimateTokens } from './contextBudget';
import type { ModelMessageRow } from './modelMessages';

/**
 * True when the pre-trim seeded projection's estimated prompt tokens exceed
 * `budgetTokens − COMPACTION_RESERVE_TOKENS`. Empty / zero-row projections →
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
  const reserve =
    Number.isFinite(COMPACTION_RESERVE_TOKENS) && COMPACTION_RESERVE_TOKENS > 0
      ? COMPACTION_RESERVE_TOKENS
      : 0;
  const triggerLine = budgetTokens - reserve;
  if (triggerLine <= 0) return false;
  const json = JSON.stringify(rows);
  const chars = json.length;
  const estimated = Math.ceil(chars / (opts?.charsPerToken && opts.charsPerToken > 0 ? opts.charsPerToken : 4));
  return estimated > triggerLine;
}
