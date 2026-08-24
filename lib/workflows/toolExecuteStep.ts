/**
 * backend-agents B12 (#806) — `toolExecuteStep`: the **tool** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B10 core `executeTool`
 * (`lib/agent/executeTool.ts`): ONE tool name + one args object → re-resolve the
 * named tool in the assembled registry → run **that** tool's `execute` →
 * `{result, freshnessDelta}`.
 *
 * In **production** the tool world is assembled IN-STEP via the shared
 * `assembleDurableToolWorld` helper (same path as `modelGenerateStep`). The
 * route MUST NOT wire the module-level resolver — Vercel step VMs don't share
 * the route's module state. `setToolWorldResolver` is a TEST-ONLY override:
 * when set (tests), it wins; when unset (prod), the step uses the shared helper.
 *
 * The B11 walker treats `'use step'` files as leaves, so this file's imports
 * (including `lib/di` / sandbox / MCP surface) do NOT pollute the workflow
 * entry's closure — the deploy-gate lock stays intact.
 *
 * **Zero non-serializable step args:** the ONLY args are plain serializable
 * values. Closures / AbortSignal / bound runners can never pass the step
 * boundary. MCP/HTTP/sandbox handles are closed in a `finally` block.
 *
 * **B5 freshness fix:** the SAME `RunFileFreshness` object goes into both
 * `createAgentTools` (FS tools record reads) and `executeTool` (freshnessDelta
 * serialized from the same ledger). Previously a NEW ledger was created for
 * tools while a seed-based ledger was used for executeTool — read-before-edit
 * grants were lost across the step boundary.
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
import type { HttpFetchRunner } from '../agent/httpFetchTypes';
import type { PersistRunBind } from './turnLoop';

/** Serialized `toolExecuteStep` step args — plain values only. */
export interface ToolExecuteStepArgs {
  /** One tool name (from the model's tool-call delta). */
  toolName: string;
  /** One args object (`ToolCallDelta.args`). */
  callArgs?: unknown;
  /** B5-serialized file-freshness ledger seed to hydrate in-step (optional). */
  freshnessSeed?: string;
  /**
   * Serializable session scope for in-step world construction (prod path).
   * When the module-level resolver is unset (production), the step assembles
   * the full tool world from this scope via the shared helper.
   * Plain serializable values only.
   */
  scope?: { tenantId: string; userId: string; sessionId: string };
  /**
   * Pre-run sandbox bind (cwd, activeSandboxId) — passed to the shared helper
   * for FS tool assembly + sandbox resolution.
   */
  persistRunBind?: PersistRunBind;
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
 * Resolves the run-scoped tool **world** in-step: the assembled tool registry
 * (sandbox `createAgentTools(...)` merged with skill/meta/MCP/HTTP tools),
 * the redaction secret list, the cancellation signal, the shared B5 freshness
 * ledger, and optional lifecycle handles (MCP close, HTTP runner, sandbox close).
 * Injected by the engine (C14) at the workflow boundary for TESTS; in production
 * the step constructs the world itself from the serializable `scope` arg via the
 * shared `assembleDurableToolWorld` helper.
 */
export type ToolWorldResolver = (args: ToolExecuteStepArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  /** Run-scoped file-freshness ledger — shared between tools and execute. */
  freshness?: unknown;
  /** MCP close handle — called in the step's `finally` (prod + test). */
  mcpClose?: () => Promise<void>;
  /** Builtin-HTTP runner — closed in the step's `finally` (prod + test). */
  httpRunner?: HttpFetchRunner;
  /** Sandbox client close — closed in the step's `finally`. */
  sandboxClientClose?: () => Promise<void>;
};

/**
 * Module-level injectable seam for the tool world (mirror of the persist seam).
 * Wired once per run by the engine/entry for TESTS; read in-step. Default
 * FAILS CLOSED so an unwired real run falls through to the production path
 * (in-step assembly from `scope` via the shared helper).
 */
let resolveToolWorld: ToolWorldResolver = () => {
  throw new Error(
    'toolExecuteStep: no tool-world resolver wired — call setToolWorldResolver (tests) or pass scope for prod in-step assembly.',
  );
};

/** Wire the run-scoped tool-world resolver (TEST override). */
export function setToolWorldResolver(fn: ToolWorldResolver): void {
  resolveToolWorld = fn;
}

/**
 * Run exactly ONE tool as a workflow step. The step takes ONLY serializable
 * args; the tool world is resolved in-step (test resolver or prod shared
 * helper assembly). The B5 file-freshness ledger is hydrated ONCE and shared
 * between `createAgentTools` and `executeTool`.
 *
 * MCP/HTTP/sandbox handles are closed in a `finally` block — the route today
 * never calls `world.mcpClose`, so the step owns the lifecycle.
 */
export async function toolExecuteStep(
  args: ToolExecuteStepArgs,
): Promise<ToolExecuteStepResult> {
  'use step';

  // Resolve the world: tests win via the injected resolver; production falls
  // through to the shared `assembleDurableToolWorld` helper.
  let registry: Record<string, unknown>;
  let secrets: Array<string | undefined | null>;
  let signal: AbortSignal;
  let freshness: unknown;
  let mcpClose: (() => Promise<void>) | undefined;
  let httpRunner: HttpFetchRunner | undefined;
  let sandboxClientClose: (() => Promise<void>) | undefined;

  try {
    const w = resolveToolWorld(args);
    registry = w.registry ?? {};
    secrets = w.secrets ?? [];
    signal = w.signal ?? new AbortController().signal;
    freshness = w.freshness;
    mcpClose = w.mcpClose;
    httpRunner = w.httpRunner;
    sandboxClientClose = w.sandboxClientClose;
  } catch {
    // Production path: resolver unset → assemble the world in-step via the
    // shared helper (same path as modelGenerateStep → worlds cannot drift).
    if (!args.scope) {
      throw new Error(
        'toolExecuteStep: no tool-world resolver wired and no scope provided — the route must pass scope on start() args.',
      );
    }
    const { assembleDurableToolWorld } = await import(
      './assembleDurableToolWorld'
    );
    const assembled = await assembleDurableToolWorld({
      scope: args.scope,
      persistRunBind: args.persistRunBind,
      freshnessSeed: args.freshnessSeed,
    });

    // Hard deny (sandbox_forbidden) → map to sandbox_error so the loop
    // terminates cleanly. No handles were opened on this path (sandbox didn't
    // resolve ok, and buildToolWorld was never called).
    if (!assembled.ok) {
      return {
        ok: false,
        code: 'sandbox_error',
        error: assembled.error,
      };
    }

    const { world } = assembled;
    registry = world.registry;
    secrets = world.secrets;
    signal = world.signal;
    freshness = world.freshness;
    mcpClose = world.mcpClose;
    httpRunner = world.httpRunner;
    sandboxClientClose = world.sandboxClientClose;
  }

  try {
    const executeDeps: ExecuteToolDeps = {
      registry: registry ?? {},
      // B5 fix: use the world's shared freshness (from the resolver, or from
      // the shared helper which hydrates ONCE from the seed). This is the
      // SAME object createAgentTools received, so read-before-edit grants
      // survive across the step boundary.
      freshness: (freshness as ExecuteToolDeps['freshness']) ?? undefined,
      secrets,
      signal,
    };
    const result = await executeTool(executeDeps, {
      toolName: args.toolName,
      args: args.callArgs,
    });
    return result;
  } finally {
    // Close MCP/HTTP/sandbox handles — the route never does (the step owns
    // lifecycle). Ignore close errors; best-effort.
    if (mcpClose) {
      try { await mcpClose(); } catch { /* ignore MCP close errors */ }
    }
    if (httpRunner) {
      try { await httpRunner.close(); } catch { /* ignore HTTP runner close errors */ }
    }
    if (sandboxClientClose) {
      try { await sandboxClientClose(); } catch { /* ignore sandbox close errors */ }
    }
  }
}
