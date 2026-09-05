import { describe, expect, it } from 'vitest';
import {
  CONTEXT_CHARS_PER_TOKEN,
  CONTEXT_RESERVE_FRACTION,
  CONTEXT_RESERVE_MIN_TOKENS,
} from '../sessionCloudCaps';
import { estimateTokens, foldBudgetTokens } from './contextBudget';

describe('contextBudget (plan #944, rows 3 + estimator)', () => {
  it('estimateTokens uses the documented chars-per-token ratio (ceil)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(CONTEXT_CHARS_PER_TOKEN).toBe(4);
  });

  it('row 3 — foldBudgetTokens = window − max(fraction × window, floor reserve)', () => {
    // 200k window: 15% = 30k > 16384 → reserve 30k → budget 170k.
    const map = new Map([['m/a', 200_000]]);
    expect(foldBudgetTokens(map, 'm/a')).toBe(200_000 - 30_000);
    // 100k window: 15% = 15k < 16384 → floor wins → budget 83_616.
    const small = new Map([['m/b', 100_000]]);
    expect(foldBudgetTokens(small, 'm/b')).toBe(100_000 - CONTEXT_RESERVE_MIN_TOKENS);
    expect(CONTEXT_RESERVE_MIN_TOKENS).toBe(16_384);
    expect(CONTEXT_RESERVE_FRACTION).toBe(0.15);
  });

  it('row 3 — unknown window → conservative default budget (never a lie)', () => {
    const expected = 200_000 - Math.floor(0.15 * 200_000);
    expect(foldBudgetTokens(new Map(), 'x/y')).toBe(expected);
    expect(foldBudgetTokens(undefined, 'x/y')).toBe(expected);
  });

  it('a tiny window still leaves a minimal budget (≥ 1)', () => {
    const tiny = new Map([['m/t', 1]]);
    expect(foldBudgetTokens(tiny, 'm/t')).toBeGreaterThanOrEqual(1);
  });
});
