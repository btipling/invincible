/**
 * backend-agents B9 (#803) — generateOneRound tests.
 * Drives the helper against a mock `streamText` impl (same shape the AI SDK
 * returns), asserting the 10-row plan matrix:
 *  1. one round, schemas present, model returns a tool call — no execute invoked
 *  2. model returns no toolcalls — break path, finishReason surfaced
 *  3. multiple toolCalls in one round — all captured (schemas only, none executed)
 *  4. empty / trailing text — delta text matches round text
 *  5. finishReason variants — forwarded unchanged
 *  6. provider usage present — delta.usage carries the round aggregate
 *  7. events emitted on the injected writable — existing AgentStreamEvent only
 *  8. event-writable failure — fail-closed value, no uncaught throw
 *  9. /api/agent untouched — no route/file under app/api changed (scoped by PR)
 * 10. di-gate green — module takes injected impl, no in-body I/O (verified by gate)
 */

import { describe, expect, it, vi } from 'vitest';
import { generateOneRound, type GenerateOneRoundResult } from './generateOneRound';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStream(overrides: Record<string, any> = {}) {
  return (_args: Record<string, unknown>) => ({
    fullStream: (async function* () {
      if (overrides.parts) {
        for (const part of overrides.parts) yield part;
      }
    })(),
    text: Promise.resolve(overrides.text ?? 'hello world'),
    usage: Promise.resolve(
      overrides.usage ?? { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    ),
    providerMetadata: Promise.resolve(overrides.providerMetadata),
    ...(overrides.steps !== undefined ? { steps: Promise.resolve(overrides.steps) } : {}),
  });
}

const deps = { modelId: 'anthropic/claude-sonnet-4' };

describe('generateOneRound (backend-agents B9)', () => {
  it('matrix 1: one round with tool schemas + a tool call — single round, delta toolCalls, no execute invoked', async () => {
    const execute = vi.fn();
    const tools = {
      list_dir: {
        description: 'List a directory',
        parameters: {},
        execute,
      },
    };
    const streamTextImpl = vi.fn(
      makeStream({
        parts: [{ type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', args: { path: '.' } }],
      }),
    );
    const events: unknown[] = [];
    const result: GenerateOneRoundResult = await generateOneRound(
      { ...deps, streamTextImpl },
      {
        messages: [{ role: 'user', content: 'list dir' }],
        tools,
        onEvent: (ev) => {
          events.push(ev);
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.toolCalls).toEqual([
      { toolName: 'list_dir', toolCallId: 'c1', args: { path: '.' } },
    ]);
    expect(result.delta.text).toBe('hello world');
    expect(result.delta.finishReason).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = streamTextImpl.mock.calls[0]![0] as Record<string, any>;
    expect(args.messages).toEqual([{ role: 'user', content: 'list dir' }]);
    // Schemas-only invariant: `execute` is stripped before the SDK boundary,
    // so a real `streamText` can never run a tool inside the single model round.
    expect(args.tools).not.toBe(tools);
    expect(args.tools['list_dir'].execute).toBeUndefined();
    expect(args.tools['list_dir'].description).toBe('List a directory');
    expect(args.tools['list_dir'].parameters).toEqual({});
    expect(args.tools['list_dir'].execute).toBeUndefined();
    expect(args.stopWhen).toBeDefined();
    expect(args.model).toBe('anthropic/claude-sonnet-4');
  });

  it('matrix 2: model returns no toolcalls — break path, toolCalls [], finishReason surfaced', async () => {
    const streamTextImpl = makeStream({
      parts: [{ type: 'finish', finishReason: 'stop' }],
      text: 'no tools needed',
    });
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      { messages: [{ role: 'user', content: 'hi' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.toolCalls).toEqual([]);
    expect(result.delta.finishReason).toBe('stop');
    expect(result.delta.text).toBe('no tools needed');
  });

  it('matrix 3: multiple toolCalls in one round — all captured, none executed', async () => {
    const execute = vi.fn();
    const stream = makeStream({
      parts: [
        { type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', args: { path: '.' } },
        { type: 'tool-call', toolName: 'read_file', toolCallId: 'c2', args: { path: 'AGENTS.md' } },
      ],
    });
    const streamTextImpl = vi.fn(stream);
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      {
        messages: [{ role: 'user', content: 'two calls' }],
        tools: { list_dir: { execute }, read_file: { execute } },
        onEvent: async () => {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.toolCalls).toEqual([
      { toolName: 'list_dir', toolCallId: 'c1', args: { path: '.' } },
      { toolName: 'read_file', toolCallId: 'c2', args: { path: 'AGENTS.md' } },
    ]);
    expect(execute).not.toHaveBeenCalled();
    // Schemas-only boundary holds across a multi-tool dict carrying executors.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = streamTextImpl.mock.calls[0]![0] as Record<string, any>;
    expect(args.tools['list_dir'].execute).toBeUndefined();
    expect(args.tools['read_file'].execute).toBeUndefined();
  });

  it('matrix 3b: AI SDK 7.0.52 shape — part.input (no args key) captured as delta.args', async () => {
    const execute = vi.fn();
    const stream = makeStream({
      parts: [
        // SDK 7.0.52 `TextStreamToolCallPart` has `input`, NOT `args`.
        { type: 'tool-call', toolName: 'read_file', toolCallId: 'c3', input: { path: 'src' } },
      ],
    });
    const streamTextImpl = vi.fn(stream);
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      {
        messages: [{ role: 'user', content: 'read src' }],
        tools: { read_file: { execute } },
        onEvent: async () => {},
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.toolCalls).toEqual([
      { toolName: 'read_file', toolCallId: 'c3', args: { path: 'src' } },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('matrix 4: empty text — delta text matches round text', async () => {
    const streamTextImpl = makeStream({ text: '' });
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      { messages: [{ role: 'user', content: 'hi' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.text).toBe('');
    expect(result.delta.toolCalls).toEqual([]);
  });

  it('matrix 5: finishReason variants — forwarded unchanged', async () => {
    for (const finishReason of ['stop', 'tool-calls', 'length', 'error']) {
      const streamTextImpl = makeStream({
        parts: [{ type: 'finish', finishReason }],
      });
      const result = await generateOneRound(
        { ...deps, streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.delta.finishReason).toBe(finishReason);
    }
  });

  it('matrix 6: provider usage present — delta.usage carries the round aggregate', async () => {
    const streamTextImpl = makeStream({
      parts: [{ type: 'finish', finishReason: 'stop' }],
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    });
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.usage).toEqual({
      source: 'provider',
      prompt: 12,
      completion: 34,
      total: 46,
    });
  });

  it('matrix 7: events emitted on the injected writable — existing AgentStreamEvent types only, wire order preserved', async () => {
    const streamTextImpl = makeStream({
      parts: [
        { type: 'text-delta', text: 'one ' },
        { type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1', args: {} },
        { type: 'text-delta', text: 'two' },
      ],
    });
    const events: unknown[] = [];
    const result = await generateOneRound(
      { ...deps, streamTextImpl },
      {
        messages: [{ role: 'user', content: 'x' }],
        tools: { list_dir: {} },
        onEvent: (ev) => {
          events.push(ev);
        },
      },
    );
    expect(result.ok).toBe(true);
    const eventTypes = events.map((e) => (e as { type: string }).type);
    expect(eventTypes).toEqual(['text_delta', 'tool_start', 'text_delta']);
    for (const ev of events) {
      const t = (ev as { type: string }).type;
      expect(
        ['tool_start', 'tool_result', 'reasoning_delta', 'text_delta', 'skill_attached', 'done', 'usage', 'error', 'provider'],
      ).toContain(t);
    }
  });

  it('matrix 8: event-writable failure — fail-closed value, no uncaught throw', async () => {
    const streamTextImpl = makeStream({
      parts: [{ type: 'text-delta', text: 'hi' }],
    });
    let threw = false;
    let result: GenerateOneRoundResult | undefined;
    try {
      result = await generateOneRound(
        { ...deps, streamTextImpl },
        {
          messages: [{ role: 'user', content: 'x' }],
          tools: {},
          onEvent: () => {
            throw new Error('writable closed');
          },
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.code).toBe('write_error');
      expect(result!.error).toContain('writable closed');
    }
  });

  it('matrix 8b: model-slice failure — fail-closed value, code model_error', async () => {
    const streamTextImpl = () => {
      throw new Error('provider down');
    };
    const result = await generateOneRound(
      { ...deps, streamTextImpl: streamTextImpl as never },
      { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_error');
      expect(result.error).toContain('provider down');
    }
  });

  it('matrix 8c: abort — fail-closed value, code cancelled', async () => {
    const streamTextImpl = () => ({
      fullStream: (async function* () {
        const err = new Error('cancel');
        err.name = 'AbortError';
        throw err;
      })(),
      text: Promise.resolve(''),
      usage: Promise.resolve(undefined),
    });
    const result = await generateOneRound(
      { ...deps, streamTextImpl: streamTextImpl as never },
      { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('cancelled');
    }
  });

  it('secrets are redacted from returned text', async () => {
    const streamTextImpl = makeStream({ text: 'my api key is sk-1234 end' });
    const result = await generateOneRound(
      { ...deps, streamTextImpl, secrets: ['sk-1234'] },
      { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delta.text).not.toContain('sk-1234');
  });
});

async function withAgentReasoningEnv<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env.AGENT_REASONING;
  try {
    if (value === undefined) delete process.env.AGENT_REASONING;
    else process.env.AGENT_REASONING = value;
    return await fn();
  } finally {
    if (prev == null) delete process.env.AGENT_REASONING;
    else process.env.AGENT_REASONING = prev;
  }
}

describe('generateOneRound reasoning (plan #846)', () => {
  it('sets streamArgs.reasoning to low for a reasoning-capable model id', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      const result = await generateOneRound(
        { modelId: 'xai/grok-4.1-fast-reasoning', streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      expect(streamTextImpl).toHaveBeenCalledTimes(1);
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('low');
    });
  });

  it('sets streamArgs.reasoning to low for glm-5.3-flash (not provider-default)', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      await generateOneRound(
        { modelId: 'zai/glm-5.3-flash', streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('low');
      expect(args.reasoning).not.toBe('provider-default');
    });
  });

  it('omits streamArgs.reasoning for a non-reasoning model when env unset', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      const result = await generateOneRound(
        { ...deps, streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args).not.toHaveProperty('reasoning');
      if (result.ok) expect(result.delta).not.toHaveProperty('reasoning');
    });
  });

  it('sets streamArgs.reasoning to none when AGENT_REASONING=none (does not omit)', async () => {
    await withAgentReasoningEnv('none', async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      const result = await generateOneRound(
        { modelId: 'xai/grok-4.1-fast-reasoning', streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('none');
    });
  });

  it('AGENT_REASONING=high overrides even a non-reasoning model id', async () => {
    await withAgentReasoningEnv('high', async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      await generateOneRound(
        { ...deps, streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('high');
    });
  });

  it('deps.reasoning request wins over AGENT_REASONING env', async () => {
    await withAgentReasoningEnv('high', async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      await generateOneRound(
        { modelId: 'zai/glm-5.3-flash', streamTextImpl, reasoning: 'low' },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('low');
    });
  });

  it('accumulates mapped reasoning_delta events into delta.reasoning', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = makeStream({
        parts: [
          { type: 'reasoning-delta', text: 'Hmm' },
          { type: 'reasoning-delta', text: '…' },
          { type: 'text-delta', text: 'hi' },
        ],
        text: 'hi',
      });
      const result = await generateOneRound(
        { ...deps, streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delta.reasoning).toBe('Hmm…');
    });
  });

  it('redacts secrets in accumulated reasoning', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const secret = 'sk-reason-secret';
      const streamTextImpl = makeStream({
        parts: [{ type: 'reasoning-delta', text: `see ${secret}` }],
      });
      const result = await generateOneRound(
        { ...deps, streamTextImpl, secrets: [secret] },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delta.reasoning).toBe('see [redacted]');
      expect(result.delta.reasoning).not.toContain(secret);
    });
  });

  it('omits delta.reasoning when no reasoning parts (or empty text)', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = makeStream({
        parts: [
          { type: 'reasoning-delta', text: '' },
          { type: 'text-delta', text: 'hi' },
        ],
        text: 'hi',
      });
      const result = await generateOneRound(
        { ...deps, streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.delta).not.toHaveProperty('reasoning');
    });
  });

  it('omits system on streamArgs when deps.system is undefined', async () => {
    const streamTextImpl = vi.fn(makeStream({ text: 'x' }));
    await generateOneRound(
      { ...deps, streamTextImpl },
      { messages: [{ role: 'user', content: 'hi' }], tools: {}, onEvent: async () => {} },
    );
    const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
    expect('system' in args).toBe(false);
  });

  it('forwards system when deps.system is a string', async () => {
    const streamTextImpl = vi.fn(makeStream({ text: 'x' }));
    await generateOneRound(
      { ...deps, streamTextImpl, system: 'Be concise.' },
      { messages: [{ role: 'user', content: 'hi' }], tools: {}, onEvent: async () => {} },
    );
    const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.system).toBe('Be concise.');
  });

  it('plan #906: emits providerHint first; metadata overlay wins; missing stays omit', async () => {
    const events: unknown[] = [];
    const hinted = await generateOneRound(
      { ...deps, streamTextImpl: makeStream({ text: 'ok' }), providerHint: 'togetherai' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        onEvent: (ev) => {
          events.push(ev);
        },
      },
    );
    expect(hinted.ok).toBe(true);
    if (!hinted.ok) return;
    expect(hinted.delta.resolvedProvider).toBe('togetherai');
    expect((events[0] as { type: string; provider?: string }).type).toBe('provider');
    expect((events[0] as { provider?: string }).provider).toBe('togetherai');

    const overlayEvents: unknown[] = [];
    const overlay = await generateOneRound(
      {
        ...deps,
        providerHint: 'togetherai',
        streamTextImpl: makeStream({
          text: 'ok',
          providerMetadata: { gateway: { providerName: 'Fireworks' } },
        }),
      },
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        onEvent: (ev) => {
          overlayEvents.push(ev);
        },
      },
    );
    expect(overlay.ok).toBe(true);
    if (!overlay.ok) return;
    expect(overlay.delta.resolvedProvider).toBe('fireworks');
    const providerEvents = overlayEvents.filter(
      (e) => (e as { type: string }).type === 'provider',
    ) as Array<{ provider: string }>;
    expect(providerEvents.map((e) => e.provider)).toEqual(['togetherai', 'fireworks']);

    const miss = await generateOneRound(
      { ...deps, streamTextImpl: makeStream({ text: 'ok' }) },
      { messages: [{ role: 'user', content: 'hi' }], tools: {}, onEvent: async () => {} },
    );
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.delta).not.toHaveProperty('resolvedProvider');
  });
});
