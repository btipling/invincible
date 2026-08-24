/**
 * backend-agents B12 (#806) — `toolExecuteStep`: the **tool** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B10 core `executeTool`
 * (`lib/agent/executeTool.ts`): ONE tool name + one args object → re-resolve the
 * named tool in the assembled registry → run **that** tool's `execute` →
 * `{result, freshnessDelta}`.
 *
 * **Zero non-serializable step args** (plan #806 lock): the args this step
 * receives are plain values only (a tool name string + one args object + the
 * B5-serialized file-freshness ledger seed). No closures / bound runners / seams
 * cross the boundary. Grants/BYOK/sandbox/MCP/http re-resolution happens
 * **inside** this step (it has full Node) via the injected registry builder —
 * never smuggled in as args.
 *
 * Business errors are **values**, not throws (mirrors the B10 core): a tool that
 * soft-fails returns its string as `result`; `tool_not_found` / `cancelled` are
 * `{ok:false}` returns. Infra/transient failures re-throw so the SDK's 3× retry
 * applies only there (never 3× exec / 3× DeepSeek on a business error).
 *
 * Re-resolution seam (`deps`): `resolveRegistry` is injected by the engine /
 * entry (see B12 turnWorkflow) so this step file's static closure stays CLEAN of
 * the banned surface (it ships only the B10 core's clean closure). Real
 * sandbox/MCP/http registry assembly lands with the engine rows (C14+).
 */

import {
  executeTool,
  type ExecuteToolDeps,
} from '../agent/executeTool';
import {
  createRunFileFreshness,
  hydrateRunFileFreshness,
} from '../agent/fileFreshness';

/** Serialized `toolExecuteStep` step args — plain values only. */
export interface ToolExecuteStepArgs {
  /** One tool name (from the model's tool-call delta). */
  toolName: string;
  /** One args object (`ToolCallDelta.args`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callArgs?: unknown;
  /** B5-serialized file-freshness ledger seed to hydrate in-step (optional). */
  freshnessSeed?: string;
}

/** Fail-closed step result (mirror B10 `ExecuteToolResult`). */
export type ToolExecuteStepResult =
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
    };

/**
 * Injected step deps (the engine/entry resolves these — this step never
 * constructs I/O in-body). `registry` mirrors the B10 core's assembled
 * one-tool dict so the step can run `executeTool` with the world re-resolved
 * at the boundary.
 */
export interface ToolExecuteStepDeps {
  /** Assembled one-tool registry (sandbox + extra) or a builder that returns it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry?: Record<string, any>;
  /** Optional redaction list, resolved by the caller. */
  secrets?: Array<string | undefined | null>;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Run exactly ONE tool as a workflow step. Re-resolves the tool registry in-step
 * (from injected `deps`), hydrates the B5 file-freshness ledger from the
 * serialized seed arg, calls the B10 core, and returns the result as a value.
 * `freshnessSeed` is the only *durable* freshness transport across the step
 * boundary (a plain string, never a closure) — the ledger lives in-process for
 * the tool half, exactly as the loop's delta discipline intends.
 */
export async function toolExecuteStep(
  deps: ToolExecuteStepDeps,
  args: ToolExecuteStepArgs,
): Promise<ToolExecuteStepResult> {
  'use step';

  const executeDeps: ExecuteToolDeps = {
    registry: deps.registry ?? {},
    freshness: args.freshnessSeed ? hydrateRunFileFreshness(args.freshnessSeed) : createRunFileFreshness(),
    secrets: deps.secrets,
    signal: deps.signal,
  };
  const result = await executeTool(executeDeps, {
    toolName: args.toolName,
    args: args.callArgs,
  });
  return result;
}
