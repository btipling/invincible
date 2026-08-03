import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_MAX_STEPS,
  MAX_AGENT_MAX_STEPS,
  SANDBOX_NOT_CONFIGURED_ERROR,
  getSandboxConfig,
  resolveAgentMaxSteps,
  resolveAgentModelId,
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

  it('resolveAgentMaxSteps default and clamp 1…12', () => {
    expect(resolveAgentMaxSteps({})).toBe(DEFAULT_AGENT_MAX_STEPS);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '3' })).toBe(3);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '0' })).toBe(1);
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: '99' })).toBe(
      MAX_AGENT_MAX_STEPS,
    );
    expect(resolveAgentMaxSteps({ AGENT_MAX_STEPS: 'nope' })).toBe(
      DEFAULT_AGENT_MAX_STEPS,
    );
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
