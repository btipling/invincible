import { describe, expect, it } from 'vitest';
import {
  isTruncatedFinish,
  STEP_BUDGET_ERROR,
  STEP_BUDGET_WRAPUP,
  STEP_BUDGET_WRAPUP_SYSTEM,
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

