/**
 * backend-agents B12 (#806) — `toolExecuteStep`: the **tool** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B10 core `executeTool`
 * (`lib/agent/executeTool.ts`): ONE tool name + one args object → re-resolve the
 * named tool in the assembled registry → run **that** tool's `execute` →
 * `{result, freshnessDelta}`.
 *
 * **Zero non-serializable step args** (plan #806 lock + adversarial L1): the ONLY
 * args this `'use step'` fn may receive are plain serializable values (a tool
 * name string + one args object + the B5-serialized file-freshness ledger seed).
 * Vercel serializes EVERY argument to a `'use step'` function, so closures /
 * AbortSignal / bound runners can never be passed in. The tool **world**
 * (registry of execute closures, redaction secrets, cancellation signal) is
 * therefore resolved **inside** the step — from a module-level injectable
 * resolver (`setToolWorldResolver`) that the engine (C14) wires at the boundary,
 * exactly as the plan lock dictares ("re-resolve grants/BYOK/sandbox/MCP inside
 * the step, not as args").
 *
 * The resolver is a module-scoped injected value, not a static import — so this
 * file's static closure stays CLEAN of the banned surface (it ships only the B10
 * core's clean closure) and the `'use workflow'` entry importing it stays inside
 * the B11 deploy-gate lock. Real sandbox/MCP/http registry assembly lands with
 * the engine rows (C14+); until then the default resolver fails closed.
 *
 * Business errors are **values**, not throws (mirrors the B10 core): a tool that
 * soft-fails returns its string as `result`; `tool_not_found` / `cancelled` are
 * `{ok:false}` returns. Infra/transient failures re-throw so the SDK's 3× retry
 * applies only there (never 3× exec / 3× DeepSeek on a business error).
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
 * Resolves the run-scoped tool **world** in-step: the assembled one-tool
 * registry (sandbox `createAgentTools(...)` merged with caller `extraTools`),
 * the redaction secret list, and the optional cancellation signal. Injected by
 * the engine (C14) at the workflow boundary — never a serialized step arg.
 */
export type ToolWorldResolver = (args: ToolExecuteStepArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
};

/**
 * Module-level injectable seam for the tool world (mirror of the persist seam).
 * Wired once per run by the engine/entry at the boundary; read in-step. Default
 * FAILS CLOSED so an unwired real run cannot silently become `tool_not_found`.
 */
let resolveToolWorld: ToolWorldResolver = () => {
  throw new Error(
    'toolExecuteStep: no tool-world resolver wired — call setToolWorldResolver (engine/C14 wires the registry before start).',
  );
};

/** Wire the run-scoped tool-world resolver (engine/entry boundary; tests inject too). */
export function setToolWorldResolver(fn: ToolWorldResolver): void {
  resolveToolWorld = fn;
}

/**
 * Run exactly ONE tool as a workflow step. The step takes ONLY serializable
 * args; the tool world is resolved in-step from the injected resolver
 * (registry / secrets / signal). Hydrates the B5 file-freshness ledger from the
 * serialized seed arg, calls the B10 core, and returns the result as a value.
 */
export async function toolExecuteStep(
  args: ToolExecuteStepArgs,
): Promise<ToolExecuteStepResult> {
  'use step';

  const world = resolveToolWorld(args);
  const executeDeps: ExecuteToolDeps = {
    registry: world.registry ?? {},
    freshness: args.freshnessSeed
      ? hydrateRunFileFreshness(args.freshnessSeed)
      : createRunFileFreshness(),
    secrets: world.secrets,
    signal: world.signal,
  };
  const result = await executeTool(executeDeps, {
    toolName: args.toolName,
    args: args.callArgs,
  });
  return result;
}
