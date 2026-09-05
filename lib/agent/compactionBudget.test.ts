/**
 * Tests for the compaction trigger estimate (plan #948, source #552 — A4
 * phase 1, Testing row 5 / adversarial #953): `shouldCompact` true only when
 * the pre-trim estimate exceeds `budgetTokens` (the #944 fold budget — not
 * fold-budget-minus-16384); empty rows → false; degenerate budgets → false
 * (fail-open, never compact on a lie).
 */
import { describe, expect, it } from 'vitest';
import { COMPACTION_RESERVE_TOKENS } from '../sessionCloudCaps';
import { shouldCompact } from './compactionBudget';
import type { ModelMessageRow } from './compaction';
import { estimateTokens } from './contextBudget';

const user = (content: string): ModelMessageRow => ({ role: 'user', content });

describe('shouldCompact (plan #948 row 5 / adversarial #953)', () => {
  it('true only when the estimate exceeds budgetTokens (the fold budget)', () => {
    const rows = [user('x'.repeat(400))]; // serialized 400+ chars → ~100+ tokens
    const json = JSON.stringify(rows);
    const est = estimateTokens(json);
    expect(shouldCompact(rows, est)).toBe(false);
    expect(shouldCompact(rows, est - 1)).toBe(true);
  });

  it('a 32k-class fold budget (=== COMPACTION_RESERVE_TOKENS) can still compact', () => {
    // foldBudgetTokens(32k window) = 16384. Extra-subtracting the Pi reserve
    // used to force triggerLine <= 0 → never compact (adversarial #953).
    expect(COMPACTION_RESERVE_TOKENS).toBe(16_384);
    const fat = [user('x'.repeat(80_000))]; // ~20k+ tokens
    expect(estimateTokens(JSON.stringify(fat))).toBeGreaterThan(COMPACTION_RESERVE_TOKENS);
    expect(shouldCompact(fat, COMPACTION_RESERVE_TOKENS)).toBe(true);
    expect(shouldCompact([user('tiny')], COMPACTION_RESERVE_TOKENS)).toBe(false);
  });

  it('zero / empty rows → false (nothing to compact)', () => {
    expect(shouldCompact([], 100_000)).toBe(false);
  });

  it('degenerate / non-finite budgets → false (fail-open, never compact on a lie)', () => {
    const rows = [user('ask')];
    expect(shouldCompact(rows, 0)).toBe(false);
    expect(shouldCompact(rows, -5)).toBe(false);
    expect(shouldCompact(rows, Number.NaN)).toBe(false);
    expect(shouldCompact(rows, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('empty-ish rows under the line → false; reuses the #944 estimator ratio', () => {
    const rows = [user('tiny')];
    expect(shouldCompact(rows, 100_000)).toBe(false);
    expect(shouldCompact(rows, 2, { charsPerToken: 1000 })).toBe(false);
    const chars = JSON.stringify(rows).length;
    expect(shouldCompact(rows, chars, { charsPerToken: 1 })).toBe(false);
    expect(shouldCompact(rows, chars - 1, { charsPerToken: 1 })).toBe(true);
  });
});
