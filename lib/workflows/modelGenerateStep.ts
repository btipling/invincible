/**
 * backend-agents B12 (#806) — `modelGenerateStep`: the **model** half of the
 * durable turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B9 core `generateOneRound`
 * (`lib/agent/generateOneRound.ts`): ONE LLM round, tool **schemas only** (no
 * `execute`), returning the normalized DELTA `{text, toolCalls, usage,
 * finishReason}` — not the full transcript.
 *
 * **Zero non-serializable step args** (plan #806 lock): the only args this step
 * may legally receive are plain serializable values (the messages array + tool
 * SCHEMA dict + a model id string). No closures / bound runners / seams cross
 * the step boundary. Everything durable is re-resolved *inside* the step
 * (model/BYOK), never smuggled in as args.
 *
 * The step returns the delta; the loop core writes the SSE lines from that delta
 * (`write SSE (text / reasoning / tool_start)`), so this wrapper does NOT open
 * its own `getWritable()` — the loop owns the SSE wire. The B9 `onEvent` is
 * internal (a no-op sink); the returned delta is the authoritative carrier, and
 * the loop emits the `AgentStreamEvent`-shaped SSE it needs.
 *
 * Errors are business-error-as-value (mirrors the B9 core): a model failure
 * returns `{ok:false, code:'model_error'|'cancelled', ...}`, never an uncaught
 * throw into the orchestrator.
 *
 * Static graph: reaches only `generateOneRound`'s clean closure (no db/mcp/blob/
 * crypto/dns) → the `'use workflow'` entry importing this stays inside the B11
 * lock (regression: `lib/workflows/staticGraph.test.ts` / `turnLoop.test.ts`).
 */

import {
  generateOneRound,
  type GenerateOneRoundInput,
  type OneRoundDelta,
} from '../agent/generateOneRound';

/** Serialized `modelGenerateStep` step args — plain values only. */
export interface ModelGenerateStepArgs {
  /** Messages for this single round (reconstructed on replay from deltas). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: ReadonlyArray<any>;
  /** Tool schemas ONLY (names/bodies, never `execute`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  /** Server-resolved model id string (request-scoped BYOK). */
  modelId: string;
}

/** Fail-closed step result (same shape as the B9 core). */
export type ModelGenerateStepResult =
  | { ok: true; delta: OneRoundDelta }
  | { ok: false; code: 'model_error' | 'write_error' | 'cancelled'; error: string };

/**
 * Run exactly ONE model round as a workflow step. Calls the B9 core, returning
 * the delta as a value. The B9 `onEvent` sink is a no-op: the loop writes the
 * SSE from the returned delta (single SSE owner).
 */
export async function modelGenerateStep(
  args: ModelGenerateStepArgs,
): Promise<ModelGenerateStepResult> {
  'use step';

  const input: GenerateOneRoundInput = {
    messages: args.messages,
    tools: args.tools,
    onEvent: async () => {
      /* The delta is the authoritative carrier; the loop emits SSE from it. */
    },
  };

  const result = await generateOneRound({ modelId: args.modelId }, input);
  if (result.ok) return { ok: true, delta: result.delta };
  return { ok: false, code: result.code, error: result.error };
}
