import { describe, expect, it } from 'vitest';
import {
  modelIdLooksReasoningCapable,
  resolveAgentReasoning,
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
});

describe('resolveAgentReasoning', () => {
  it('uses AGENT_REASONING when valid', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-non-reasoning', {
        AGENT_REASONING: 'high',
      }),
    ).toBe('high');
    expect(
      resolveAgentReasoning('any', { AGENT_REASONING: 'none' }),
    ).toBe('none');
    expect(
      resolveAgentReasoning('any', { AGENT_REASONING: 'provider-default' }),
    ).toBe('provider-default');
  });

  it('ignores invalid AGENT_REASONING', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-non-reasoning', {
        AGENT_REASONING: 'turbo',
      }),
    ).toBeUndefined();
  });

  it('defaults provider-default for reasoning/thinking model ids', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-reasoning', {}),
    ).toBe('provider-default');
    expect(
      resolveAgentReasoning('moonshotai/kimi-k2-thinking', {}),
    ).toBe('provider-default');
  });

  it('omits for non-reasoning models when env unset', () => {
    expect(
      resolveAgentReasoning('xai/grok-4.1-fast-non-reasoning', {}),
    ).toBeUndefined();
    expect(resolveAgentReasoning('anthropic/claude-sonnet-4', {})).toBeUndefined();
  });
});
