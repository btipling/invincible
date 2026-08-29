/**
 * backend-agents B12 (#806) — `modelGenerateStep`: the **model** half of the
 * durable turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B9 core `generateOneRound`
 * (`lib/agent/generateOneRound.ts`): ONE LLM round, tool **schemas only** (no
 * `execute`), returning the normalized DELTA `{text, toolCalls, usage,
 * finishReason, reasoning?}` — not the full transcript.
 *
 * The tool surface is assembled IN-STEP via the shared `assembleDurableToolWorld`
 * helper (same path as `toolExecuteStep`), then stripped to schemas-only via
 * `toolsWithoutExecutors`. The model MUST see the same tools the execute step
 * can run — otherwise the model cannot call FS/MCP/HTTP/skill tools and a
 * durable coding turn is a dead letter.
 *
 * In **production** BYOK is re-resolved IN-STEP: the route passes only
 * serializable `{ userId, modelId }` (never api keys). Inside the step,
 * `resolveByokForRequest(userId, modelId)` resolves the tenant BYOK and
 * attaches `providerOptions.gateway.{only,byok}` + the redact list onto
 * `generateOneRound`. On BYOK fail the step returns `{ok:false,
 * code:'model_error'}` — it NEVER calls `streamText` with a bare `modelId`.
 *
 * **Zero non-serializable step args** (plan #806 lock): the only args this step
 * may legally receive are plain serializable values (the messages array + model
 * id + user id + scope + optional persistRunBind). No closures / bound runners /
 * seams cross the step boundary.
 *
 * The step returns the delta for persist / tool dispatch. Live SSE
 * (`reasoning_delta` / `text_delta` / `tool_start`) is written **inside this
 * step** via `withDefaultStreamWriter` (`lib/workflows/turnSseWrite.ts`, no
 * `'use step'`) as `generateOneRound` `onEvent` fires — one held writer for
 * the round, not `getWritable()` per token. Not dumped by the loop after
 * return. The loop still owns `tool_result` / `done` / close. Do **not**
 * import `turnSseStep` from this file (nested `'use step'`).
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
  type OneRoundDelta,
} from '../agent/generateOneRound';
import { toolsWithoutExecutors } from '../agent/generateOneRound';
import { toModelMessages } from './toModelMessages';
import { logTurnModel } from './turnLog';
import { formatLiveModelSse } from './turnSseFormat';
import { withDefaultStreamWriter } from './turnSseWrite';
import type { PersistRunBind } from './turnLoop';

/** Serialized `modelGenerateStep` step args — plain values only. */
export interface ModelGenerateStepArgs {
  /** Messages for this single round (reconstructed on replay from deltas). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: ReadonlyArray<any>;
  /** Server-resolved model id string (request-scoped BYOK). */
  modelId: string;
  /**
   * User id for in-step BYOK re-resolution (prod path). The route passes this
   * as a plain serializable value — never api keys or provider options.
   */
  userId: string;
  /**
   * Serializable session scope for in-step tool-world assembly.
   * The model must see the FULL durable tool surface (FS + skill/meta + MCP +
   * HTTP), assembled via the shared `assembleDurableToolWorld` helper — same
   * path as `toolExecuteStep` so the worlds cannot drift.
   */
  scope: { tenantId: string; userId: string; sessionId: string };
  /**
   * Pre-run sandbox bind (cwd, activeSandboxId) — passed to the shared helper
   * for FS tool assembly.
   */
  persistRunBind?: PersistRunBind;
}

/** Fail-closed step result (same shape as the B9 core). */
export type ModelGenerateStepResult =
  | { ok: true; delta: OneRoundDelta }
  | { ok: false; code: 'model_error' | 'write_error' | 'cancelled'; error: string };

/**
 * Run exactly ONE model round as a workflow step. In production, re-resolves
 * BYOK in-step (tenant BYOK always; never host env-model) and assembles the
 * FULL durable tool surface (shared `assembleDurableToolWorld`) then strips to
 * schemas-only via `toolsWithoutExecutors`. Returns the delta as a value.
 */
export async function modelGenerateStep(
  args: ModelGenerateStepArgs,
): Promise<ModelGenerateStepResult> {
  'use step';

  // Re-resolve BYOK in-step from serializable { userId, modelId }.
  // Tenant BYOK always — never host env-model (SECURITY.md). On failure
  // return {ok:false} — do NOT call streamText with a bare modelId.
  const { createProdServices } = await import('../di/index');
  const services = createProdServices();
  const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
    args.userId,
    args.modelId,
  );

  if (!byok.ok) {
    logTurnModel({ ok: false, code: 'model_error' });
    return {
      ok: false,
      code: 'model_error',
      error: `BYOK resolve failed: ${byok.reason}`,
    };
  }

  // Assemble the FULL durable tool world in-step — same shared helper as
  // toolExecuteStep so the worlds cannot drift. The model must see every tool
  // the execute step can run (FS + skill/meta + MCP + HTTP), stripped to
  // schemas-only via toolsWithoutExecutors.
  const { assembleDurableToolWorld } = await import(
    './assembleDurableToolWorld'
  );
  const assembled = await assembleDurableToolWorld({
    scope: args.scope,
    persistRunBind: args.persistRunBind,
  });

  // Hard deny (sandbox_forbidden) → map to model_error so the loop terminates
  // cleanly. No handles were opened on this path (sandbox didn't resolve ok,
  // and we haven't called buildToolWorld).
  if (!assembled.ok) {
    logTurnModel({ ok: false, code: 'model_error' });
    return {
      ok: false,
      code: 'model_error',
      error: assembled.error,
    };
  }

  const { world } = assembled;

  let toolSchemas: ReturnType<typeof toolsWithoutExecutors>;
  try {
    toolSchemas = toolsWithoutExecutors(world.registry);
  } finally {
    // Close lifecycle handles — the model step only needed schemas.
    // Always close, even if toolsWithoutExecutors throws (e.g. malformed tool
    // object in the registry). Best-effort; ignore close errors.
    if (world.mcpClose) {
      try { await world.mcpClose(); } catch { /* ignore */ }
    }
    if (world.httpRunner) {
      try { await world.httpRunner.close(); } catch { /* ignore */ }
    }
    if (world.sandboxClientClose) {
      try { await world.sandboxClientClose(); } catch { /* ignore */ }
    }
  }

  const result = await withDefaultStreamWriter(async (write) =>
    generateOneRound(
      {
        modelId: byok.modelId,
        providerOptions: {
          gateway: {
            only: byok.only,
            byok: byok.byok,
          },
        },
        secrets: byok.secretsToRedact,
      },
      {
        messages: toModelMessages(args.messages),
        tools: toolSchemas,
        onEvent: async (ev) => {
          const line = formatLiveModelSse(ev);
          if (line) await write(line);
        },
      },
    ),
  );
  if (result.ok) {
    logTurnModel({
      ok: true,
      finishReason: result.delta.finishReason,
      toolCallCount: result.delta.toolCalls.length,
      textChars: result.delta.text.length,
    });
    return { ok: true, delta: result.delta };
  }
  logTurnModel({ ok: false, code: result.code });
  return { ok: false, code: result.code, error: result.error };
}
