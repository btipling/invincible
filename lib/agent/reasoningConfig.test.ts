import { describe, expect, it } from 'vitest';
import {
  coerceReasoningForGateway,
  defaultEffortFromOptions,
  modelIdLooksReasoningCapable,
  resolveAgentReasoning,
  shouldFetchEffortCatalog,
} from './reasoningConfig';

describe('modelIdLooksReasoningCapable', () => {
  it('handles non-reasoning substring trap', () => {
    expect(modelIdLooksReasoningCapable('xai/grok-4.1-fast-non-reasoning')).toBe(
      false,
    );
    expect(modelIdLooksReasoningCapable('xai/grok-4.1-fast-reasoning')).toBe(true);
    expect(modelIdLooksReasoningCapable('moonshotai/kimi-k2-thinking')).toBe(true);
    expect(modelIdLooksReasoningCapable('anthropic/claude-sonnet-4')).toBe(false);
  });

  it('treats glm-5* ids as reasoning-capable', () => {
    expect(modelIdLooksReasoningCapable('zai/glm-5.3-flash')).toBe(true);
    expect(modelIdLooksReasoningCapable('glm-5.3')).toBe(true);
    expect(modelIdLooksReasoningCapable('zai/glm-5')).toBe(true);
    expect(modelIdLooksReasoningCapable('glm-5')).toBe(true);
  });

  it('does not treat glm-4 / glm-50 as glm-5', () => {
    expect(modelIdLooksReasoningCapable('zai/glm-4.5')).toBe(false);
    expect(modelIdLooksReasoningCapable('glm-50')).toBe(false);
    expect(modelIdLooksReasoningCapable('openglm-5.3')).toBe(false);
  });
});

describe('defaultEffortFromOptions', () => {
  it('prefers low then minimal then medium then none', () => {
    expect(defaultEffortFromOptions(['high', 'low', 'max'])).toBe('low');
    expect(defaultEffortFromOptions(['minimal', 'high'])).toBe('minimal');
    expect(defaultEffortFromOptions(['medium', 'high'])).toBe('medium');
    expect(defaultEffortFromOptions(['none', 'high'])).toBe('none');
  });

  it('returns first remaining non-max token', () => {
    expect(defaultEffortFromOptions(['high', 'xhigh'])).toBe('high');
  });

  it('omits when empty or only max/xhigh/provider-default', () => {
    expect(defaultEffortFromOptions([])).toBeUndefined();
    expect(defaultEffortFromOptions(['max'])).toBeUndefined();
    expect(defaultEffortFromOptions(['xhigh', 'max', 'provider-default'])).toBeUndefined();
  });
});

describe('resolveAgentReasoning', () => {
  it('uses AGENT_REASONING when valid', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-non-reasoning', {
        env: { AGENT_REASONING: 'high' },
      }),
    ).toBe('high');
    expect(
      resolveAgentReasoning('any', { env: { AGENT_REASONING: 'none' } }),
    ).toBe('none');
    expect(
      resolveAgentReasoning('any', {
        env: { AGENT_REASONING: 'provider-default' },
      }),
    ).toBe('provider-default');
  });

  it('ignores AGENT_REASONING=max (not in env allowlist)', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', {
        env: { AGENT_REASONING: 'max' },
        options: [],
      }),
    ).toBe('low');
  });

  it('request wins over env', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', {
        request: 'low',
        env: { AGENT_REASONING: 'high' },
      }),
    ).toBe('low');
  });

  it('defaults low for reasoning/thinking model ids when options empty', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-reasoning', {
        env: {},
        options: [],
      }),
    ).toBe('low');
    expect(
      resolveAgentReasoning('moonshotai/kimi-k2-thinking', { env: {} }),
    ).toBe('low');
  });

  it('defaults low for glm-5* when env unset and options empty', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', { env: {}, options: [] }),
    ).toBe('low');
  });

  it('uses Gateway list instead of inventing off-list low', () => {
    expect(
      resolveAgentReasoning('deepseek/x', {
        env: {},
        options: ['high', 'xhigh'],
      }),
    ).toBe('high');
    expect(
      resolveAgentReasoning('any', { env: {}, options: ['max'] }),
    ).toBeUndefined();
  });

  it('never returns provider-default unless env or request said so', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', { env: {} }),
    ).not.toBe('provider-default');
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-reasoning', { env: {} }),
    ).not.toBe('provider-default');
  });

  it('omits for non-reasoning models when env unset', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-non-reasoning', { env: {} }),
    ).toBeUndefined();
    expect(
      resolveAgentReasoning('anthropic/claude-sonnet-4', { env: {} }),
    ).toBeUndefined();
  });

  it('coerces request max to high when catalog is empty (skip-catalog fallback)', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', {
        request: 'max',
        env: {},
        options: [],
      }),
    ).toBe('high');
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', {
        request: 'max',
        env: {},
        options: ['low', 'high'],
      }),
    ).toBe('high');
  });

  it('coerces request max to xhigh when the published list includes it', () => {
    expect(
      resolveAgentReasoning('zai/glm-5.3-flash', {
        request: 'max',
        env: {},
        options: ['low', 'high', 'xhigh'],
      }),
    ).toBe('xhigh');
    expect(
      resolveAgentReasoning('openai/gpt-5.6-luna', {
        request: 'MAX',
        env: {},
        options: ['none', 'low', 'medium', 'high', 'xhigh'],
      }),
    ).toBe('xhigh');
  });
});

describe('coerceReasoningForGateway', () => {
  it('passes wire tokens through', () => {
    expect(coerceReasoningForGateway('low')).toBe('low');
    expect(coerceReasoningForGateway('xhigh', ['high', 'xhigh'])).toBe('xhigh');
    expect(coerceReasoningForGateway('provider-default')).toBe('provider-default');
  });

  it('maps max → xhigh if listed, else high', () => {
    expect(coerceReasoningForGateway('max', ['none', 'high', 'xhigh'])).toBe(
      'xhigh',
    );
    expect(coerceReasoningForGateway('max', ['low', 'high'])).toBe('high');
    expect(coerceReasoningForGateway('max', [])).toBe('high');
    expect(coerceReasoningForGateway('max')).toBe('high');
  });

  it('drops max when the list has neither high nor xhigh', () => {
    expect(coerceReasoningForGateway('max', ['none', 'minimal'])).toBeUndefined();
  });

  it('drops unknown non-wire tokens', () => {
    expect(coerceReasoningForGateway('budget')).toBeUndefined();
    expect(coerceReasoningForGateway(undefined)).toBeUndefined();
  });
});

describe('shouldFetchEffortCatalog (#911 adversarial-review)', () => {
  it('fetches when the body is omitted or non-wire (max)', () => {
    expect(shouldFetchEffortCatalog(undefined)).toBe(true);
    expect(shouldFetchEffortCatalog('max')).toBe(true);
    expect(shouldFetchEffortCatalog('MAX')).toBe(true);
  });

  it('skips when the body is already a Gateway wire token', () => {
    expect(shouldFetchEffortCatalog('low')).toBe(false);
    expect(shouldFetchEffortCatalog('xhigh')).toBe(false);
    expect(shouldFetchEffortCatalog('provider-default')).toBe(false);
  });
});
