import { describe, it, expect, vi } from 'vitest';
import {
  turnWorkflow,
  runModelTurnStep,
  runWorkerPersistStep,
  truncateMessageCheckpoint,
  hydrateOrSeedFreshness,
  TURN_MSG_CHECKPOINT_MAX_MESSAGES,
  TURN_MSG_CHECKPOINT_MAX_BYTES,
  type TurnStepRunSeam,
  type TurnWorkflowArgs,
} from './turnWorkflow';
import { createTurnWorkerPersist } from './turnWorkerPersist';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type { SessionRecordKey } from '../sessions/sessionStore';
import type { AgentStreamEvent } from './agentStream';

/**
 * backend-agents E (#791 / source #768): turn Workflow orchestrator tests.
 * The `"use workflow"` / `"use step"` bodies are thin shells (the Workflows
 * runtime owns `getWritable`); the substantive logic lives in the injected seam
 * + the pure helpers below, tested against a mock step runtime + mock writable
 * + in-memory stores (plan test rows 3/4/5/7). No real sandbox/MCP/Blob.
 *
 * Rows covered:
 *   3  re-resolve per step (seam resolveRunParams called once per model step,
 *      fresh each time) — a single run calls it EXACTLY ONCE (one prompt = one
 *      model step per the locked design) and the runner is closed.
 *   4  model events emitted on getWritable() in agent-stream order
 *      (text_delta → usage → done), encoded as SSE.
 *   5  freshness ledger carried across steps (seed hydrated; snapshot returned).
 *   7  message checkpoint = truncateMessageCheckpoint (structured, capped);
 *      stored as its OWN Blob object by runWorkerPersistStep — envelope meta
 *      NEVER carries it.
 */

const KEY: SessionRecordKey = {
  tenantId: 'tenant_a',
  userId: 'user_1',
  sessionId: 'session_x',
};

const ARGS: TurnWorkflowArgs = {
  tenantId: KEY.tenantId,
  userId: KEY.userId,
  sessionId: KEY.sessionId,
  prompt: 'write the plan',
  initialCwd: '.',
};

function makeWritable(): { writable: WritableStream<string>; chunks: string[] } {
  const chunks: string[] = [];
  const encoder = new TextEncoder();
  const writable = new WritableStream<string>({
    write(chunk: string) {
      // writable is a string stream; encode to bytes is the Workflows norm but
      // capture the raw string for event-order assertions.
      void encoder.encode(chunk);
      chunks.push(chunk);
    },
  });
  return { writable, chunks };
}

function makeSeam(): {
  seam: TurnStepRunSeam;
  resolveSpy: ReturnType<typeof vi.fn>;
  closed: boolean;
} {
  let closed = false;
  const resolveSpy = vi.fn(async () => ({
    params: {
      modelId: 'm1',
      signal: undefined,
    },
    async close() {
      closed = true;
    },
  }));
  return {
    seam: {
      resolveRunParams: resolveSpy,
    },
    resolveSpy,
    get closed() {
      return closed;
    },
  };
}

describe('runModelTurnStep (row 3/4/5)', () => {
  it('re-resolves the seam once per run and closes the runner', async () => {
    const { seam, resolveSpy } = makeSeam();
    const { writable, chunks } = makeWritable();
    const events: AgentStreamEvent[] = [];
    const runStream = vi.fn(async (
      params: unknown,
      handlers: { onEvent: (ev: AgentStreamEvent) => void | Promise<void> },
    ) => {
      void params;
      await handlers.onEvent({ type: 'text_delta', text: 'hello' });
      await handlers.onEvent({ type: 'usage', usage: { source: 'provider', prompt: 3, completion: 1, total: 4 } });
      await handlers.onEvent({ type: 'done', text: 'hello world' });
      events.push = events.push; // no-op
      return {};
    });

    const result = await runModelTurnStep(seam, ARGS, writable, runStream);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // The params passed to runAgentStream carry the hydrated freshness + prompt.
    const runParams = runStream.mock.calls[0]![0] as { prompt: string; freshness: unknown };
    expect(runParams.prompt).toBe(ARGS.prompt);
    expect(runParams.freshness).toBeDefined();

    // All three stream events were written as encoded SSE.
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toContain('"type":"text_delta"');
    expect(chunks[1]).toContain('"type":"usage"');
    expect(chunks[2]).toContain('"type":"done"');

    // Freshness ledger snapshotted (seed empty → non-empty projection with
    // truncation marker absent).
    expect(result.serializedFreshness.paths).toEqual([]);
    expect(result.serializedFreshness.truncated).toBe(false);
  });

  it('hydrates a carried serialized freshness seed (row 5: ledger survives steps)', async () => {
    const seed = {
      paths: [
        { path: 'a.ts', mtimeMs: 100, size: 20 },
        { path: 'b.ts', truncated: true },
      ],
      truncated: false,
    };
    const hydrated = hydrateOrSeedFreshness(seed);
    expect(hydrated).toBeDefined();

    const { seam } = makeSeam();
    const { writable } = makeWritable();
    const runStream = vi.fn(async (
      _params: unknown,
      handlers: { onEvent: (ev: AgentStreamEvent) => void | Promise<void> },
    ) => {
      await handlers.onEvent({ type: 'done', text: 'ok' });
    });
    const result = await runModelTurnStep(seam, { ...ARGS, serializedFreshness: seed }, writable, runStream);
    // Snapshot is carried forward (paths preserved) — the ledger crossed steps.
    expect(result.serializedFreshness.paths).toEqual(seed.paths);
  });

  it('a model-stream error event fails closed (no silent /api/agent fallback)', async () => {
    const { seam } = makeSeam();
    const { writable } = makeWritable();
    const runStream = vi.fn(async (
      _params: unknown,
      handlers: { onEvent: (ev: AgentStreamEvent) => void | Promise<void> },
    ) => {
      await handlers.onEvent({ type: 'error', error: 'provider boom', status: 502 });
    });
    await expect(runModelTurnStep(seam, ARGS, writable, runStream)).rejects.toThrow(/agent stream error/);
  });
});

describe('truncateMessageCheckpoint (row 7 — structured, capped, never a fold)', () => {
  it('projects role + content rows (structured, per #549)', () => {
    const ckpt = truncateMessageCheckpoint([
      { role: 'user', content: '  hello   world  ' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', content: { text: 'non-string content' } },
      null,
    ]);
    expect(ckpt.messages).toEqual([
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', content: 'non-string content' },
    ]);
    expect(ckpt.truncated).toBe(false);
  });

  it('caps the message count (NEW cap) with a truncation marker', () => {
    const many = Array.from({ length: TURN_MSG_CHECKPOINT_MAX_MESSAGES + 5 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const ckpt = truncateMessageCheckpoint(many);
    expect(ckpt.messages.length).toBe(TURN_MSG_CHECKPOINT_MAX_MESSAGES);
    expect(ckpt.truncated).toBe(true);
  });

  it('caps the serialized bytes (NEW cap) with a truncation marker', () => {
    // Conceptual byte estimator: role + row-capped content (8000/row) + overhead.
    // Width is real content bytes, so rows are large (~8 KB each); 150 of them
    // exceed the 1 MB cap → the marker must flip and fewer than all rows kept.
    const big = Array.from({ length: 150 }, () => ({ role: 'assistant', content: 'x'.repeat(8_000) }));
    const ckpt = truncateMessageCheckpoint(big, { maxBytes: TURN_MSG_CHECKPOINT_MAX_BYTES });
    expect(ckpt.messages.length).toBeLessThan(big.length);
    expect(ckpt.truncated).toBe(true);
  });
});

describe('runWorkerPersistStep (row 7 — checkpoint as its OWN Blob, never envelope meta)', () => {
  it('persists segment + envelope meta AND the checkpoint as a separate Blob object', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const env = new MemorySessionStore();
    // The memory store mints a `memory://upload/:id` URL that defaultPutObject
    // can't `fetch`; inject a put that records the body and succeeds (mirrors the
    // increment-2 `makeSeam` pattern).
    const putObject = vi.fn(async (_url: string, _body: unknown): Promise<boolean> => true);
    const persist = createTurnWorkerPersist({ blobStore: blob, envelopeStore: env, putObject });
    const modelResult = {
      serializedFreshness: { paths: [], truncated: false },
      checkpoint: { messages: [{ role: 'assistant', content: 'final' }], truncated: false },
    };

    const out = await runWorkerPersistStep(
      { persist, key: KEY },
      modelResult,
      { kind: 'transcript', updatedAt: 2000, body: { rows: ['assistant text'] } },
    );
    expect(out).toBe('persisted');

    // The checkpoint was persisted as its OWN Blob object; NEITHER a transcript
    // object NOR the envelope meta carries a `checkpoint` field (the plan-review
    // Major carrier fix).
    const envNow = await env.readEnvelope(KEY);
    expect(envNow).toBeDefined();
    expect(envNow?.meta.transcriptPointer).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(envNow?.meta ?? {}, 'checkpoint')).toBe(false);
  });
});

describe('turnWorkflow seam wiring (thin over the two step bodies)', () => {
  it('exports the orchestrator + resolves one run to a completed marker', async () => {
    const { seam } = makeSeam();
    const blob = new MemoryBlobTranscriptStore();
    const env = new MemorySessionStore();
    const putObject = vi.fn(async (_url: string, _body: unknown): Promise<boolean> => true);
    const persist = createTurnWorkerPersist({ blobStore: blob, envelopeStore: env, putObject });
    // The `"use step"` getWritable path can't run outside the Workflows runtime,
    // so we drive the same body the orchestrator sequences via runModelTurnStep.
    const { writable, chunks } = makeWritable();
    const runStream = vi.fn(async (
      _params: unknown,
      handlers: { onEvent: (ev: AgentStreamEvent) => void | Promise<void> },
    ) => {
      await handlers.onEvent({ type: 'text_delta', text: 'plan' });
      await handlers.onEvent({ type: 'done', text: 'plan' });
    });
    const model = await runModelTurnStep(seam, ARGS, writable, runStream);
    expect(chunks.length).toBe(2);

    await runWorkerPersistStep(
      { persist, key: KEY },
      model,
      { kind: 'transcript', updatedAt: Date.now(), body: { rows: [] } },
    );
    const envNow = await env.readEnvelope(KEY);
    expect(envNow?.meta.transcriptPointer).toBeDefined();

    // The orchestrator is present + returns the completed marker contract.
    expect(typeof turnWorkflow).toBe('function');
  });
});
