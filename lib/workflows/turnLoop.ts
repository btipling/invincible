/**
 * backend-agents B12 (#806) — `"use workflow"` turn orchestrator loop core.
 *
 * The pure, testable while-loop that drives one prompt run. Per the umbrella
 * (#794) Architecture lock, ONE run = ONE prompt, and ONE step boundary = one
 * model round OR one tool execution OR one persist. The loop lives in workflow
 * context; it calls the three thin `'use step'` wrappers
 * (`modelGenerateStep` / `toolExecuteStep` / `persistStep`) which each re-resolve
 * the world in-step from serializable args.
 *
 * **Deliberately directive-free** (no `"use workflow"` / `"use step"` in this
 * file) so the whole matrix runs under plain vitest without the Vercel-Workflows
 * transform. The `'use workflow'` entry (`turnWorkflow.ts`) is the directive
 * carrier that binds `getWritable()` and calls this core.
 *
 * Lock discipline (B11 #805, deploy-gate):
 *  - Step I/O = **deltas** (`{text,toolCalls,usage,finishReason}` / `{result,
 *    freshnessDelta}` / terminal persist status), never the full transcript.
 *  - Tokens ride `getWritable()` (this core writes SSE event lines to the
 *    injected writable); the transcript/checkpoint live in Blob (B13 persist).
 *  - The writable is closed **exactly once** on every terminal path — success,
 *    model/tool/persist fail (`{ok:false}` value), 256-cap, or cancel. A failed
 *    terminal step never tears down the loop without closing the wire.
 *  - Tool business errors are **values**, not throws: a step returning
 *    `{ok:false}` terminates the loop cleanly (never retried 3× by the SDK).
 *  - No `/api/agent` fallback, no wrapping `runAgentStream` in one step.
 *
 * Messages are reconstructed **on replay** from the step deltas this core
 * records in `deltas` (that is the orchestrator-local transcript the loop is
 * allowed to keep — never the full transcript, which is Blob; see B13).
 */

import type { PersistStepFold } from './persistStep';

/**
 * Local structural model-round delta. Defined here (NOT imported from
 * `generateOneRound`) so this directive-free core carries zero static coupling
 * to that file — its own closure stays deploy-gate clean (plan #805 lock) and
 * the loop needs only the shape, not the B9 implementation. Structurally
 * identical to `generateOneRound.OneRoundDelta`; `modelGenerateStep` (the
 * wrapper) is the only module that bridges this core to the B9 implementation.
 */
export type TurnLoopDelta = {
  text: string;
  toolCalls: TurnToolCallDelta[];
  finishReason?: string;
};

export type TurnToolCallDelta = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

/**
 * NEW workflow-scoped cap (plan #806 Caps table): max workflow **steps** per
 * prompt run, where EVERY step boundary counts ONE (each model round + each
 * tool execution + each persist). This is a STEP bound, not a round bound
 * (adversarial L6): a per-round tool fanout cannot exceed the budget.
 * `256*2 (model+tool) + persist ≪ 2k-event slow-replay line` (Vercel: 25k
 * events/run, 2 GB entity). Addressable under `MAX_AGENT_MAX_STEPS`
 * (`lib/sandbox/config.ts`, 1_000_000, unchanged — no existing-cap change, no
 * human gate). The parent locked 256 as the NEW workflow cap value; this PR
 * fixes its counting unit to steps (not rounds).
 */
export const MAX_WORKFLOW_STEPS = 256;

/** Minimal writable surface the loop needs — a `WritableStream`-like carve. */
export interface TurnWritable {
  write(line: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Serialized SSE event line the loop writes per step (delta-only carriers). */
export type TurnSseLine =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string }
  | { type: 'tool_start'; toolName: string; toolCallId?: string }
  | { type: 'tool_result'; toolName: string; ok: boolean; result?: string }
  | { type: 'done'; finishReason?: string; rounds: number; steps: number }
  | { type: 'error'; message: string };

/** Model-step wrapper contract (eventually `modelGenerateStep`). */
export interface ModelStepFn {
  (args: {
    messages: ReadonlyArray<unknown>;
  }): Promise<
    | { ok: true; delta: TurnLoopDelta }
    | { ok: false; code: 'model_error' | 'write_error' | 'cancelled'; error: string }
  >;
}

/** Tool-step wrapper contract (eventually `toolExecuteStep`). */
export interface ToolStepFn {
  (args: {
    toolName: string;
    toolCallId?: string;
    callArgs?: unknown;
    /**
     * B5-serialized file-freshness ledger seed from the prior tool step(s) in
     * this run — threaded so read-before-edit grants survive across steps and
     * rounds (adversarial L1). A plain string, never a closure.
     */
    freshnessSeed?: string;
  }): Promise<
    | { ok: true; result: string; freshnessDelta: string }
    | {
        ok: false;
        code:
          | 'tool_not_found'
          | 'sandbox_error'
          | 'http_error'
          | 'mcp_error'
          | 'violation'
          | 'cancelled';
        error: string;
      }
  >;
}

/** Persist-step wrapper contract (eventually `persistStep`). */
export interface PersistStepFn {
  (args: {
    turnRunId: string;
    deltas: ReadonlyArray<unknown>;
    /** Run final-state fold (B13) — plain serializable values only. */
    fold?: PersistStepFold;
  }): Promise<
    | { ok: true; status: 'completed'; turnRunId: string }
    | { ok: false; code: string; error: string }
  >;
}

/** Injected dependencies for the loop core — steps + the SSE writable. */
export interface TurnLoopDeps {
  modelStep: ModelStepFn;
  toolStep: ToolStepFn;
  persistStep: PersistStepFn;
  writable: TurnWritable;
  /** Cap override for tests. Defaults to {@link MAX_WORKFLOW_STEPS}. */
  maxSteps?: number;
  /** Workflow run id — NEVER a session id (plan lock). */
  turnRunId: string;
  /**
   * Run final-state fold (B13): cwd/usage/activeSandboxId + the bounded
   * checkpoint projection, threaded to the terminal persist step as plain
   * serializable values. Supplied by the engine (C14) from the run's last
   * generate/tool deltas; optional for tests/in-memory seams.
   */
  persistFold?: PersistStepFold;
}

/** Loop input: the user turn (orchestrator-local starting message). */
export interface TurnLoopInput {
  userMessage: string;
}

/** Terminal result + the delta log for replay reconstruction (roundtrip). */
export interface TurnLoopResult {
  status: 'completed' | 'capped' | 'cancelled' | 'failed';
  /**
   * Replay-reconstruction source: every step delta in wire order. The loop is
   * allowed to keep these (orchestrator-local) — never the full transcript.
   */
  deltas: unknown[];
  /** Reconstructed `[user, *assistant/tool deltas]` on replay. */
  messages: unknown[];
  rounds: number;
  /**
   * Total workflow steps executed (model + each tool + persist, each == 1).
   * Bounded by {@link MAX_WORKFLOW_STEPS} — the cap counts STEPS, not rounds
   * (adversarial L6), so a per-round tool fanout cannot blow the budget.
   */
  steps: number;
  error?: string;
}

/** Always-serializable writable guard: close exactly once, fail-soft. */
export function onceWritable(writable: TurnWritable): TurnWritable {
  let closed = false;
  return {
    write: (line) => writable.write(line),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      try {
        return Promise.resolve(writable.close());
      } catch {
        return Promise.resolve();
      }
    },
  };
}

const sse = (line: TurnSseLine): string => `data: ${JSON.stringify(line)}\n\n`;

/**
 * Drive one prompt run: `model · (tool)*` until the model returns no tool calls
 * or the 256-step cap is reached, writing delta-only SSE lines to the writable,
 * then persist the terminal state. Closes the writable on EVERY terminal path.
 *
 * This core holds no closures that cross a step boundary: every arg passed to a
 * step is a plain serializable value (messages / tool name + args / turnRunId +
 * deltas). Re-resolution of grants/model/sandbox happens inside the steps.
 */
export async function runTurnLoop(
  deps: TurnLoopDeps,
  input: TurnLoopInput,
): Promise<TurnLoopResult> {
  const cap = Math.max(0, Math.floor(deps.maxSteps ?? MAX_WORKFLOW_STEPS));
  const writable = onceWritable(deps.writable);
  const deltas: unknown[] = [];
  const messages: unknown[] = [{ role: 'user', content: input.userMessage }];

  const fail = async (
    status: TurnLoopResult['status'],
    round: number,
    steps: number,
    error?: string,
  ): Promise<TurnLoopResult> => {
    if (error) await writable.write(sse({ type: 'error', message: error }));
    await writable.close();
    return {
      status,
      deltas,
      messages,
      rounds: round,
      steps,
      ...(error !== undefined ? { error } : {}),
    };
  };

  let round = 0;
  let steps = 0;
  // Thread the B5 file-freshness ledger across tool steps — and across rounds.
  // Every tool step seeds from the accumulated serialized ledger and returns the
  // advanced delta, so read-before-edit grants survive the durable loop
  // (adversarial L1). A plain string, never a closure.
  let freshness: string | undefined;
  try {
    while (steps < cap) {
      round += 1;
      steps += 1; // this model round = one step boundary
      // ONE model round — schemas only, never execute (B9 core). Delta return.
      const gen = await deps.modelStep({ messages });
      if (!gen.ok) {
        return fail(gen.code === 'cancelled' ? 'cancelled' : 'failed', round, steps, gen.error);
      }
      deltas.push(gen.delta);
      if (gen.delta.text) {
        await writable.write(sse({ type: 'text', text: gen.delta.text }));
      }
      messages.push({ role: 'assistant', delta: gen.delta });

      // No tool calls → this model round is terminal; persist and close.
      const calls: TurnToolCallDelta[] = gen.delta.toolCalls ?? [];
      if (calls.length === 0) {
        await writable.write(
          sse({ type: 'done', finishReason: gen.delta.finishReason, rounds: round, steps }),
        );
        steps += 1; // the persist step
        const persisted = await deps.persistStep({
          turnRunId: deps.turnRunId,
          deltas,
          ...(deps.persistFold !== undefined ? { fold: deps.persistFold } : {}),
        });
        if (!persisted.ok) {
          return fail('failed', round, steps, persisted.error);
        }
        deltas.push(persisted);
        messages.push({ role: 'persist', status: persisted.status });
        await writable.write(sse({ type: 'done', rounds: round, steps }));
        await writable.close();
        return { status: 'completed', deltas, messages, rounds: round, steps };
      }

      // Each tool call is its OWN step — re-resolve + run THE named tool, seeded
      // with the run's accumulated file-freshness ledger. The cap counts every
      // step (model + each tool + persist), so a per-round tool fanout cannot
      // blow the workflow budget (adversarial L6).
      for (const call of calls) {
        if (steps >= cap) break; // no remaining step budget → capped
        steps += 1; // this tool execution = one step boundary
        await writable.write(
          sse({ type: 'tool_start', toolName: call.toolName, toolCallId: call.toolCallId }),
        );
        const tool = await deps.toolStep({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          callArgs: call.args,
          freshnessSeed: freshness,
        });
        if (tool.ok) {
          freshness = tool.freshnessDelta;
          deltas.push(tool);
          messages.push({ role: 'tool', toolName: call.toolName, result: tool.result });
          await writable.write(
            sse({ type: 'tool_result', toolName: call.toolName, ok: true, result: tool.result }),
          );
        } else {
          // Business error as a VALUE — never a throw; terminate cleanly.
          if (tool.code === 'cancelled') {
            return fail('cancelled', round, steps, tool.error);
          }
          await writable.write(
            sse({ type: 'tool_result', toolName: call.toolName, ok: false, result: tool.error }),
          );
          deltas.push(tool);
          messages.push({ role: 'tool', toolName: call.toolName, ok: false, error: tool.error });
          await writable.close();
          return {
            status: 'completed',
            deltas,
            messages,
            rounds: round,
            steps,
            error: tool.error,
          };
        }
      }
    }

    // Step budget exhausted (model + tool step count hit the cap): never
    // infinite. Terminal state + close.
    const capped: TurnLoopResult = {
      status: 'capped',
      deltas,
      messages,
      rounds: round,
      steps,
    };
    await writable.write(sse({ type: 'done', rounds: round, steps }));
    await writable.close();
    return capped;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('failed', round, steps, message);
  }
}
