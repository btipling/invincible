/**
 * Tests for the compaction trigger estimate (plan #948, source #552 — A4
 * phase 1, Testing row 5): `shouldCompact` true only when the pre-trim
 * estimate exceeds `budgetTokens − COMPACTION_RESERVE_TOKENS`; empty rows →
 * false; degenerate budgets → false (fail-open, never compact on a lie).
 */
import { describe, expect, it } from 'vitest';
import { COMPACTION_RESERVE_TOKENS } from '../sessionCloudCaps';
import { shouldCompact } from './compactionBudget';
import type { ModelMessageRow } from './compaction';
import { estimateTokens } from './contextBudget';

const user = (content: string): ModelMessageRow => ({ role: 'user', content });

describe('shouldCompact (plan #948 row 5)', () => {
  it('true only when the estimate exceeds budgetTokens − COMPACTION_RESERVE_TOKENS', () => {
    expect(COMPACTION_RESERVE_TOKENS).toBe(16_384);
    const rows = [user('x'.repeat(400))]; // serialized 400+ chars → ~100+ tokens
    const json = JSON.stringify(rows);
    const est = estimateTokens(json);
    // Trigger line = budget − reserve. estimate == line → NOT above → false;
    // a SMALLER budget lowers the line above the estimate → true.
    const budget = est + COMPACTION_RESERVE_TOKENS;
    expect(shouldCompact(rows, budget)).toBe(false);
    expect(shouldCompact(rows, est + COMPACTION_RESERVE_TOKENS - 1)).toBe(true);
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
    // A budget smaller than the reserve leaves no positive trigger line.
    expect(shouldCompact(rows, COMPACTION_RESERVE_TOKENS - 1)).toBe(false);
    // Exactly the reserve → trigger line 0 → false.
    expect(shouldCompact(rows, COMPACTION_RESERVE_TOKENS)).toBe(false);
  });

  it('empty-ish rows under the line → false; reuses the #944 estimator ratio', () => {
    const rows = [user('tiny')];
    expect(shouldCompact(rows, 100_000)).toBe(false);
    // charsPerToken override honored (test seam): ratio 1000 → estimate ~0 →
    // under any positive line → false; ratio 1 with budget 1 → line 1−16384
    // ≤ 0 → false (degenerate); ratio 1 with budget = reserve + estimate
    // chars → line == chars → boundary → use reserve+1 to be above.
    expect(shouldCompact(rows, 2, { charsPerToken: 1000 })).toBe(false);
    expect(shouldCompact(rows, 1, { charsPerToken: 1 })).toBe(false);
    const chars = JSON.stringify(rows).length;
    expect(shouldCompact(rows, COMPACTION_RESERVE_TOKENS + chars, { charsPerToken: 1 })).toBe(false);
    expect(shouldCompact(rows, COMPACTION_RESERVE_TOKENS + chars - 1, { charsPerToken: 1 })).toBe(true);
  });
});
