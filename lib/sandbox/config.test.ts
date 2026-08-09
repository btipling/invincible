import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AGENT_MAX_STEPS,
  SANDBOX_NOT_CONFIGURED_ERROR,
  getSandboxConfig,
  resolveAgentMaxSteps,
  resolveAgentModelId,
  resolveSandboxDefaultCwd,
  resetSandboxDefaultCwdLogForTests,
  sandboxConfigured,
} from './config';

describe('sandbox config', () => {
  it('sandboxConfigured requires both URL and token', () => {
    expect(sandboxConfigured({})).toBe(false);
    expect(sandboxConfigured({ SANDBOX_URL: 'http://x' })).toBe(false);
    expect(sandboxConfigured({ SANDBOX_TOKEN: 't' })).toBe(false);
    expect(
      sandboxConfigured({ SANDBOX_URL: 'http://x', SANDBOX_TOKEN: 't' }),
    ).toBe(true);
    expect(
      sandboxConfigured({ SANDBOX_URL: '  ', SANDBOX_TOKEN: 't' }),
    ).toBe(false);
  });

  it('getSandboxConfig normalizes trailing slash', () => {
    const cfg = getSandboxConfig({
      SANDBOX_URL: 'http://127.0.0.1:8787/',
      SANDBOX_TOKEN: 'secret',
    });
    expect(cfg).toEqual({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'secret',
    });
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

  it('resolveAgentModelId prefers AGENT_MODEL', () => {
    expect(resolveAgentModelId({ AGENT_MODEL: 'xai/tool-model' })).toBe(
      'xai/tool-model',
    );
    expect(resolveAgentModelId({ DEFAULT_MODEL: 'xai/fallback' })).toBe(
      'xai/fallback',
    );
  });

  it('503 error string is stable for host matching', () => {
    expect(SANDBOX_NOT_CONFIGURED_ERROR).toBe(
      'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    );
  });
});

describe('resolveSandboxDefaultCwd', () => {
  afterEach(() => {
    resetSandboxDefaultCwdLogForTests();
  });

  it('returns . when unset or blank', () => {
    expect(resolveSandboxDefaultCwd({})).toBe('.');
    expect(resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: '' })).toBe('.');
    expect(resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: '   ' })).toBe('.');
  });

  it('returns normalized workspace-relative path', () => {
    expect(resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: 'invincible' })).toBe(
      'invincible',
    );
    expect(
      resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: '  invincible/sub  ' }),
    ).toBe('invincible/sub');
  });

  it('invalid env falls back to . without throw', () => {
    expect(resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: '/etc' })).toBe('.');
    expect(resolveSandboxDefaultCwd({ SANDBOX_DEFAULT_CWD: 'C:\\Windows' })).toBe(
      '.',
    );
  });
});
