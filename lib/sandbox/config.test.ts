import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_MAX_STEPS,
  resolveAgentMaxSteps,
  normalizeBaseUrl,
} from './config';

describe('sandbox config', () => {
  it('normalizeBaseUrl strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8787/')).toBe(
      'http://127.0.0.1:8787',
    );
    expect(normalizeBaseUrl('http://127.0.0.1:8787///')).toBe(
      'http://127.0.0.1:8787',
    );
  });

  it('resolveAgentMaxSteps is null when unset; clamps only absurd extremes', () => {
    expect(resolveAgentMaxSteps({})).toBeNull();
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '' })).toBeNull();
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '   ' })).toBeNull();
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: 'nope' })).toBeNull();
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '3' })).toBe(3);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '0' })).toBe(1);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '999' })).toBe(999);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '256' })).toBe(256);
    expect(
      resolveAgentMaxSteps({ AGENT_MAX_STEPS: String(MAX_AGENT_MAX_STEPS + 1) }),
    ).toBe(MAX_AGENT_MAX_STEPS);
  });

  it('does not export legacy 503 / default-cwd bootstrap symbols', async () => {
    // Phase 3 (#476): SANDBOX_DEFAULT_CWD / resolveSandboxDefaultCwd /
    // SANDBOX_NOT_CONFIGURED_ERROR are removed; normalizeBaseUrl stays.
    // Cast through any: absent named exports are read as undefined on the
    // module namespace without tripping the static type check.
    const mod = (await import('./config')) as Record<string, unknown>;
    expect(mod.normalizeBaseUrl).toBeTypeOf('function');
    expect(mod.SANDBOX_NOT_CONFIGURED_ERROR).toBeUndefined();
    expect(mod.resolveSandboxDefaultCwd).toBeUndefined();
    expect(mod.resetSandboxDefaultCwdLogForTests).toBeUndefined();
  });
});
