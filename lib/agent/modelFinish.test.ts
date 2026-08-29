import { describe, expect, it } from 'vitest';
import {
  CONTENT_FILTER_ERROR,
  isTruncatedFinish,
  MODEL_FINISH_ERROR,
  OUTPUT_TRUNCATED_ERROR,
  STEP_BUDGET_ERROR,
  STEP_BUDGET_WRAPUP,
  STEP_BUDGET_WRAPUP_SYSTEM,
  truncatedFinishError,
} from './modelFinish';
import { DEFAULT_AGENT_SYSTEM } from './agentSystem';
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

describe('truncatedFinishError', () => {
  it('maps length / content-filter / error to distinct canvas strings', () => {
    expect(truncatedFinishError('length')).toBe(OUTPUT_TRUNCATED_ERROR);
    expect(truncatedFinishError('content-filter')).toBe(CONTENT_FILTER_ERROR);
    expect(truncatedFinishError('error')).toBe(MODEL_FINISH_ERROR);
  });

  it('falls back to output truncated for unknown / omitted reasons', () => {
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
