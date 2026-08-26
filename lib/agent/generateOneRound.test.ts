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
import { jsonSchema, streamText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import {
  createAiSdkExecutionGuard,
  createAiSdkExecutionLock,
} from 'prefix-safe-json';
import { generateOneRound, type GenerateOneRoundResult } from './generateOneRound';
import { runTurnLoop } from '../workflows/turnLoop';

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
    ...(overrides.steps !== undefined ? { steps: Promise.resolve(overrides.steps) } : {}),
  });
}

const deps = { modelId: 'anthropic/claude-sonnet-4' };

function rawToolCall(
  toolName: string,
  toolCallId: string,
  args: unknown,
): Array<Record<string, unknown>> {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: JSON.stringify(args) },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolName, toolCallId, input: args },
  ];
}

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
        parts: [
          ...rawToolCall('list_dir', 'c1', { path: '.' }),
          { type: 'finish', finishReason: 'tool-calls' },
        ],
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
    expect(result.delta.finishReason).toBe('tool-calls');
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
    expect(args.tools['list_dir'].needsApproval).toBe(true);
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
        ...rawToolCall('list_dir', 'c1', { path: '.' }),
        ...rawToolCall('read_file', 'c2', { path: 'AGENTS.md' }),
        { type: 'finish', finishReason: 'tool-calls' },
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
        ...rawToolCall('read_file', 'c3', { path: 'src' }),
        { type: 'finish', finishReason: 'tool-calls' },
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
        ...rawToolCall('list_dir', 'c1', {}),
        { type: 'text-delta', text: 'two' },
        { type: 'finish', finishReason: 'tool-calls' },
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
        ['tool_start', 'tool_result', 'reasoning_delta', 'text_delta', 'skill_attached', 'done', 'usage', 'error'],
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
  it('sets streamArgs.reasoning to provider-default for a reasoning-capable model id', async () => {
    await withAgentReasoningEnv(undefined, async () => {
      const streamTextImpl = vi.fn(makeStream({ parts: [{ type: 'text-delta', text: 'ok' }] }));
      const result = await generateOneRound(
        { modelId: 'xai/grok-4.1-fast-reasoning', streamTextImpl },
        { messages: [{ role: 'user', content: 'x' }], tools: {}, onEvent: async () => {} },
      );
      expect(result.ok).toBe(true);
      expect(streamTextImpl).toHaveBeenCalledTimes(1);
      const args = streamTextImpl.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.reasoning).toBe('provider-default');
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
});

type ExactFinishReason = 'tool-calls' | 'length';

function exactAiModel(
  rawInput: string,
  finishReason: ExactFinishReason,
  toolName = 'write_file',
) {
  const toolCallId = 'call-integrity';
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'tool-input-start', id: toolCallId, toolName });
          controller.enqueue({ type: 'tool-input-delta', id: toolCallId, delta: rawInput });
          controller.enqueue({ type: 'tool-input-end', id: toolCallId });
          controller.enqueue({
            type: 'tool-call',
            toolCallId,
            toolName,
            input: rawInput,
          });
          controller.enqueue({
            type: 'finish',
            finishReason: {
              unified: finishReason,
              raw: finishReason === 'length' ? 'max_tokens' : 'tool_calls',
            },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

function integrityTool(calls: {
  execute: number;
  inputStart: number;
  inputDelta: number;
  inputAvailable: number;
}) {
  return tool({
    description: 'Write a file',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    onInputStart: () => {
      calls.inputStart += 1;
    },
    onInputDelta: () => {
      calls.inputDelta += 1;
    },
    onInputAvailable: () => {
      calls.inputAvailable += 1;
    },
    execute: async () => {
      calls.execute += 1;
      return 'native effect';
    },
  });
}

async function exactRound(
  rawInput: string,
  finishReason: ExactFinishReason,
  toolName = 'write_file',
) {
  const native = { execute: 0, inputStart: 0, inputDelta: 0, inputAvailable: 0 };
  const model = exactAiModel(rawInput, finishReason, toolName);
  const result = await generateOneRound(
    {
      modelId: 'exact-ai-7.0.52',
      streamTextImpl: (args) => streamText({ ...args, model }),
    },
    {
      messages: [{ role: 'user', content: 'write it' }],
      tools: { write_file: integrityTool(native) },
      onEvent: async () => {},
    },
  );
  return { result, native };
}

async function runRoundThroughDurableLoop(round: GenerateOneRoundResult) {
  const manualEffect = vi.fn(async () => ({
    ok: true as const,
    result: 'manual effect',
    freshnessDelta: '{}',
  }));
  const modelStep = vi
    .fn()
    .mockResolvedValueOnce(round)
    .mockResolvedValueOnce({
      ok: true as const,
      delta: { text: 'done', toolCalls: [], finishReason: 'stop' },
    });
  const loop = await runTurnLoop(
    {
      modelStep,
      toolStep: manualEffect,
      persistStep: async ({ turnRunId }) => ({
        ok: true as const,
        status: 'completed' as const,
        turnRunId,
      }),
      writable: { write: () => {}, close: () => {} },
      turnRunId: 'integrity-proof',
      maxSteps: 8,
    },
    { userMessage: 'write it' },
  );
  return { loop, manualEffect };
}

describe('generateOneRound execution integrity (exact ai@7.0.52)', () => {
  it('complete raw evidence disables native callbacks and authorizes one manual effect', async () => {
    const { result, native } = await exactRound(
      '{"path":"x","content":"complete"}',
      'tool-calls',
    );
    expect(result).toMatchObject({
      ok: true,
      delta: {
        toolCalls: [
          {
            toolName: 'write_file',
            toolCallId: 'call-integrity',
            args: { path: 'x', content: 'complete' },
          },
        ],
      },
    });
    expect(native).toEqual({
      execute: 0,
      inputStart: 0,
      inputDelta: 0,
      inputAvailable: 0,
    });

    const { loop, manualEffect } = await runRoundThroughDurableLoop(result);
    expect(loop.status).toBe('completed');
    expect(manualEffect).toHaveBeenCalledTimes(1);
    expect(manualEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'write_file',
        toolCallId: 'call-integrity',
        callArgs: { path: 'x', content: 'complete' },
      }),
    );
  });

  it('complete-looking JSON terminated by length reaches neither native nor manual execution', async () => {
    const { result, native } = await exactRound(
      '{"path":"x","content":"apparently complete"}',
      'length',
    );
    expect(result).toMatchObject({
      ok: true,
      delta: { toolCalls: [], finishReason: 'length' },
    });
    expect(native).toEqual({
      execute: 0,
      inputStart: 0,
      inputDelta: 0,
      inputAvailable: 0,
    });

    const { loop, manualEffect } = await runRoundThroughDurableLoop(result);
    expect(loop.status).toBe('completed');
    expect(manualEffect).not.toHaveBeenCalled();
  });

  it.each([
    ['schema-invalid input', '{"path":7,"content":"x"}', 'write_file'],
    ['malformed input', '{"path":"x"', 'write_file'],
    ['unknown tool identity', '{"path":"x","content":"x"}', 'unknown_write'],
  ])('%s is never handed to the manual executor', async (_case, raw, toolName) => {
    const { result, native } = await exactRound(raw, 'tool-calls', toolName);
    if (result.ok) expect(result.delta.toolCalls).toEqual([]);
    expect(native).toEqual({
      execute: 0,
      inputStart: 0,
      inputDelta: 0,
      inputAvailable: 0,
    });
    const { manualEffect } = await runRoundThroughDurableLoop(result);
    expect(manualEffect).not.toHaveBeenCalled();
  });

  it('projection-only, ambiguous-identity, and protocol-invalid streams fail closed', async () => {
    for (const parts of [
      [
        {
          type: 'tool-call',
          toolName: 'write_file',
          toolCallId: 'projection',
          input: { path: 'x', content: 'x' },
        },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
      [
        {
          type: 'tool-input-delta',
          id: 'protocol',
          delta: '{"path":"x","content":"x"}',
        },
        { type: 'tool-input-end', id: 'protocol' },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
      [
        { type: 'tool-input-start', id: 'duplicate', toolName: 'write_file' },
        { type: 'tool-input-start', id: 'duplicate', toolName: 'write_file' },
        {
          type: 'tool-input-delta',
          id: 'duplicate',
          delta: '{"path":"x","content":"x"}',
        },
        { type: 'tool-input-end', id: 'duplicate' },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
    ]) {
      const result = await generateOneRound(
        { ...deps, streamTextImpl: makeStream({ parts }) },
        {
          messages: [{ role: 'user', content: 'write it' }],
          tools: {
            write_file: integrityTool({
              execute: 0,
              inputStart: 0,
              inputDelta: 0,
              inputAvailable: 0,
            }),
          },
          onEvent: async () => {},
        },
      );
      expect(result).toMatchObject({ ok: true, delta: { toolCalls: [] } });
    }
  });

  it('a conflicting SDK projection cannot override the raw argument bytes', async () => {
    const result = await generateOneRound(
      {
        ...deps,
        streamTextImpl: makeStream({
          parts: [
            { type: 'tool-input-start', id: 'raw-wins', toolName: 'write_file' },
            {
              type: 'tool-input-delta',
              id: 'raw-wins',
              delta: '{"path":"raw","content":"trusted"}',
            },
            { type: 'tool-input-end', id: 'raw-wins' },
            {
              type: 'tool-call',
              toolName: 'write_file',
              toolCallId: 'raw-wins',
              input: { path: 'projection', content: 'must not win' },
            },
            { type: 'finish', finishReason: 'tool-calls' },
          ],
        }),
      },
      {
        messages: [{ role: 'user', content: 'write it' }],
        tools: {
          write_file: integrityTool({
            execute: 0,
            inputStart: 0,
            inputDelta: 0,
            inputAvailable: 0,
          }),
        },
        onEvent: async () => {},
      },
    );
    expect(result).toMatchObject({
      ok: true,
      delta: {
        toolCalls: [
          {
            toolName: 'write_file',
            toolCallId: 'raw-wins',
            args: { path: 'raw', content: 'trusted' },
          },
        ],
      },
    });
  });

  it('the exact fullStream guard exposes each executable authority only once', async () => {
    const model = exactAiModel('{"path":"x","content":"complete"}', 'tool-calls');
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    };
    const guard = createAiSdkExecutionGuard({ schemas: { write_file: schema } });
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'write it' }],
      // The lock intentionally removes callback keys from the static type;
      // streamText's ToolSet keeps them as optional picks at its boundary.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: createAiSdkExecutionLock({
        write_file: integrityTool({
          execute: 0,
          inputStart: 0,
          inputDelta: 0,
          inputAvailable: 0,
        }),
      }) as any,
    });
    for await (const part of result.fullStream) guard.push(part);
    const final = guard.finish();
    expect(final.decisions).toHaveLength(1);
    const internalId = final.decisions[0]!.internalId;
    expect(guard.takeDecision(internalId)).toMatchObject({
      action: 'execute',
      value: { path: 'x', content: 'complete' },
    });
    expect(guard.takeDecision(internalId)).toBeUndefined();
  });
});
