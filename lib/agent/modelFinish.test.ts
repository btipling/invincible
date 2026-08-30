import { describe, expect, it } from 'vitest';
import {
  CONTENT_FILTER_ERROR,
  isProviderRefusalFinish,
  MODEL_FINISH_ERROR,
  OUTPUT_TRUNCATED_ERROR,
  STEP_BUDGET_ERROR,
  STEP_BUDGET_WRAPUP,
  STEP_BUDGET_WRAPUP_SYSTEM,
  truncatedFinishError,
} from './modelFinish';
import { DEFAULT_AGENT_SYSTEM } from './agentSystem';

describe('isProviderRefusalFinish', () => {
  it('only content-filter / error fail the turn', () => {
    expect(isProviderRefusalFinish('content-filter')).toBe(true);
    expect(isProviderRefusalFinish('error')).toBe(true);
    expect(isProviderRefusalFinish('length')).toBe(false);
    expect(isProviderRefusalFinish('stop')).toBe(false);
    expect(isProviderRefusalFinish(undefined)).toBe(false);
  });
});

describe('truncatedFinishError', () => {
  it('maps content-filter / error to distinct canvas strings', () => {
    expect(truncatedFinishError('content-filter')).toBe(CONTENT_FILTER_ERROR);
    expect(truncatedFinishError('error')).toBe(MODEL_FINISH_ERROR);
  });

  it('falls back to output truncated for unknown / omitted / length (not a turn-end)', () => {
    expect(truncatedFinishError('length')).toBe(OUTPUT_TRUNCATED_ERROR);
    expect(truncatedFinishError(undefined)).toBe(OUTPUT_TRUNCATED_ERROR);
    expect(truncatedFinishError('stop')).toBe(OUTPUT_TRUNCATED_ERROR);
  });
});

describe('STEP_BUDGET_WRAPUP', () => {
  it('is an Error: line that names the step-budget error', () => {
    expect(STEP_BUDGET_WRAPUP.startsWith('Error:')).toBe(true);
    expect(STEP_BUDGET_WRAPUP).toContain(STEP_BUDGET_ERROR);
  });
});

describe('STEP_BUDGET_WRAPUP_SYSTEM', () => {
  it('is not DEFAULT_AGENT_SYSTEM and forbids tools', () => {
    expect(STEP_BUDGET_WRAPUP_SYSTEM).not.toBe(DEFAULT_AGENT_SYSTEM);
    expect(STEP_BUDGET_WRAPUP_SYSTEM).not.toMatch(/Prefer tools \(list_dir/);
    expect(STEP_BUDGET_WRAPUP_SYSTEM).toMatch(/Do not call tools/);
    expect(STEP_BUDGET_WRAPUP_SYSTEM).toMatch(/no tools/);
  });
});
