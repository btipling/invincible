import { describe, expect, it } from 'vitest';
import { isTruncatedFinish, STEP_BUDGET_ERROR, STEP_BUDGET_WRAPUP } from './modelFinish';

describe('isTruncatedFinish', () => {
  it('length / content-filter / error are truncated', () => {
    expect(isTruncatedFinish('length')).toBe(true);
    expect(isTruncatedFinish('content-filter')).toBe(true);
    expect(isTruncatedFinish('error')).toBe(true);
  });

  it('stop / omitted / tool-calls are not', () => {
    expect(isTruncatedFinish('stop')).toBe(false);
    expect(isTruncatedFinish(undefined)).toBe(false);
    expect(isTruncatedFinish('tool-calls')).toBe(false);
  });
});

describe('STEP_BUDGET_WRAPUP', () => {
  it('is an Error: line that names the step-budget error', () => {
    expect(STEP_BUDGET_WRAPUP.startsWith('Error:')).toBe(true);
    expect(STEP_BUDGET_WRAPUP).toContain(STEP_BUDGET_ERROR);
  });
});

