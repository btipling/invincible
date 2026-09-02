/**
 * Wall-clock deadline helpers (plan #923 / adversarial-review #926).
 * Directive-free — no Workflows transform.
 */
import { describe, expect, it } from 'vitest';
import {
  combineAbortSignals,
  deadlineSignal,
  isDeadlineElapsed,
} from './turnDeadline';

describe('isDeadlineElapsed', () => {
  it('undefined deadline is inert (cap not wired)', () => {
    expect(isDeadlineElapsed(undefined, 1_000)).toBe(false);
  });

  it('elapsed at or past the epoch', () => {
    expect(isDeadlineElapsed(1_000, 1_000)).toBe(true);
    expect(isDeadlineElapsed(1_000, 1_001)).toBe(true);
  });

  it('future deadline is not elapsed', () => {
    expect(isDeadlineElapsed(2_000, 1_000)).toBe(false);
  });
});

describe('deadlineSignal', () => {
  it('undefined deadline returns undefined (no signal across the boundary)', () => {
    expect(deadlineSignal(undefined, 1_000)).toBeUndefined();
  });

  it('elapsed deadline returns an already-aborted signal', () => {
    const s = deadlineSignal(1_000, 1_000);
    expect(s).toBeInstanceOf(AbortSignal);
    expect(s?.aborted).toBe(true);
  });

  it('future deadline returns a live (not yet aborted) timeout signal', () => {
    const s = deadlineSignal(Date.now() + 60_000);
    expect(s).toBeInstanceOf(AbortSignal);
    expect(s?.aborted).toBe(false);
  });
});

describe('combineAbortSignals', () => {
  it('no signals → undefined', () => {
    expect(combineAbortSignals()).toBeUndefined();
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it('one live signal is returned as-is (no extra any())', () => {
    const a = AbortSignal.abort();
    expect(combineAbortSignals(a)).toBe(a);
    expect(combineAbortSignals(undefined, a, undefined)).toBe(a);
  });

  it('any() of two: aborting one aborts the combined signal', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined?.aborted).toBe(false);
    b.abort();
    expect(combined?.aborted).toBe(true);
  });
});
