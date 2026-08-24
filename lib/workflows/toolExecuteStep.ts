/**
 * backend-agents B12 (#806) — `toolExecuteStep`: the **tool** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the merged B10 core `executeTool`
 * (`lib/agent/executeTool.ts`): ONE tool name + one args object → re-resolve the
 * named tool in the assembled registry → run **that** tool's `execute` →
 * `{result, freshnessDelta}`.
 *
 * In **production** the tool world is assembled IN-STEP from the serializable
 * `scope` arg (the route MUST NOT wire the module-level resolver — Vercel step
 * VMs don't share the route's module state). `setToolWorldResolver` is a
 * TEST-ONLY override: when set (tests), it wins; when unset (prod), the step
 * constructs the full tool world (sandbox + MCP + HTTP + skill/meta tools) from
 * `scope` plus the DI root — same assembly as `/api/agent`.
 *
 * The B11 walker treats `'use step'` files as leaves, so this file's imports
 * (including `lib/di` / sandbox / MCP surface) do NOT pollute the workflow
 * entry's closure — the deploy-gate lock stays intact.
 *
 * **Zero non-serializable step args:** the ONLY args are plain serializable
 * values. Closures / AbortSignal / bound runners can never pass the step
 * boundary. MCP/HTTP/sandbox handles are closed in a `finally` block.
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
import type { HttpFetchRunner } from '../agent/httpFetchTypes';

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
   * the full tool world from this scope. Plain serializable values only.
   */
  scope?: { tenantId: string; userId: string; sessionId: string };
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
 * the redaction secret list, the cancellation signal, and optional lifecycle
 * handles (MCP close, HTTP runner). Injected by the engine (C14) at the
 * workflow boundary for tests; in production the step constructs the world
 * itself from the serializable `scope` arg.
 */
export type ToolWorldResolver = (args: ToolExecuteStepArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  /** MCP close handle — called in the step's `finally` (prod + test). */
  mcpClose?: () => Promise<void>;
  /** Builtin-HTTP runner — closed in the step's `finally` (prod + test). */
  httpRunner?: HttpFetchRunner;
};

/**
 * Module-level injectable seam for the tool world (mirror of the persist seam).
 * Wired once per run by the engine/entry for TESTS; read in-step. Default
 * FAILS CLOSED so an unwired real run falls through to the production path
 * (in-step assembly from `scope`).
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
 * Resolve the tool world: tests win via the injected resolver; production falls
 * through to in-step assembly from the serializable `scope`.
 */
async function resolveWorld(
  args: ToolExecuteStepArgs,
): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  secrets: Array<string | undefined | null>;
  signal: AbortSignal;
  mcpClose?: () => Promise<void>;
  httpRunner?: HttpFetchRunner;
}> {
  // Test path: resolver is set → no throw → test world wins.
  try {
    const w = resolveToolWorld(args);
    return {
      registry: w.registry ?? {},
      secrets: w.secrets ?? [],
      signal: w.signal ?? new AbortController().signal,
      mcpClose: w.mcpClose,
      httpRunner: w.httpRunner,
    };
  } catch {
    // Production path: resolver unset → assemble the world in-step.
  }

  if (!args.scope) {
    throw new Error(
      'toolExecuteStep: no tool-world resolver wired and no scope provided — the route must pass scope on start() args.',
    );
  }

  const { userId, sessionId } = args.scope;
  const { createProdServices } = await import('../di/index');
  const services = createProdServices();
  const { buildToolWorld } = await import('../agent/buildToolWorld');
  const { buildUserMcpTools } = await import('../mcp/client');
  const { createAgentTools } = await import('../agent/tools');
  const { createRunFileFreshness } = await import('../agent/fileFreshness');
  const { resolveSessionStore } = await import('../tenancy/harnessSessionsRedis');

  const signal = new AbortController().signal;

  // Resolve sandbox (FS client + permissions + secrets) — same as /api/agent.
  let sandbox:
    | { client: import('../sandbox/client').SandboxClient; secrets: string[] }
    | undefined;
  let permissions: { canRead: boolean; canWrite: boolean } | undefined;
  let workspaceRoot: string | undefined;
  try {
    const resolved = await services.resolveSandbox.resolveAgentSandbox(
      userId,
      {},
      { signal },
    );
    if (resolved.ok) {
      sandbox = {
        client: resolved.value.client,
        secrets: resolved.value.secrets,
      };
      permissions = resolved.value.permissions;
      workspaceRoot = resolved.value.workspaceRoot ?? undefined;
    }
  } catch {
    // Sandbox unavailable — soft-path (no FS tools). The turn still has
    // skill/meta/MCP/HTTP tools.
  }

  // Resolve GitHub PAT for sandbox exec env.
  let ghSecrets: string[] = [];
  try {
    const gh = await services.userGithubToken.decryptUserGithubTokenForServer(userId);
    if (gh.ok && gh.value) {
      ghSecrets.push(gh.value);
    }
  } catch {
    // Fail-open: no GH token → no exec env.
  }

  // Resolve HTTP attach name.
  let httpAttachName: string | null = null;
  try {
    const loaded = await services.userSandboxInstance.loadInstance(userId, 'http');
    if (
      loaded.ok &&
      loaded.value &&
      loaded.value.status === 'running' &&
      loaded.value.vercelName?.trim()
    ) {
      httpAttachName = loaded.value.vercelName.trim();
    }
  } catch {
    // Fail-open: no HTTP instance → no HTTP tools.
  }

  // Assemble the non-FS tool world (C14a).
  const world = await buildToolWorld({
    userId,
    sessionId,
    signal,
    serverSecrets: services.serverSecrets,
    services: {
      userSkills: services.userSkills,
      userPersonas: services.userPersonas,
      userPreferredSandbox: services.userPreferredSandbox,
      userMcpServers: services.userMcpServers,
      createHttpRunner: services.createHttpRunner,
    },
    sessionStoreSeam: {
      resolveSessionStore: () => resolveSessionStore(),
      resolveTenantIdForUser: (uid: string) =>
        services.harnessSessionsRedis.resolveTenantIdForUser(uid),
    },
    buildUserMcpTools,
    byokSecretsToRedact: [],
    ghSecrets,
    ...(sandbox ? { sandbox } : {}),
    httpAttachName,
  });

  // Merge FS sandbox tools into the registry.
  let registry = world.registry;
  if (sandbox && permissions && workspaceRoot) {
    const fsTools = createAgentTools({
      client: sandbox.client,
      freshness: createRunFileFreshness(),
      permissions,
      workspaceRoot,
    });
    registry = { ...registry, ...fsTools };
  }

  return {
    registry,
    secrets: world.secrets,
    signal: world.signal,
    mcpClose: world.mcpClose,
    httpRunner: world.httpRunner,
  };
}

/**
 * Run exactly ONE tool as a workflow step. The step takes ONLY serializable
 * args; the tool world is resolved in-step (test resolver or prod in-step
 * assembly). Hydrates the B5 file-freshness ledger from the serialized seed
 * arg, calls the B10 core, and returns the result as a value.
 *
 * MCP/HTTP handles are closed in a `finally` block — the route today never
 * calls `world.mcpClose`, so the step owns the lifecycle.
 */
export async function toolExecuteStep(
  args: ToolExecuteStepArgs,
): Promise<ToolExecuteStepResult> {
  'use step';

  const world = await resolveWorld(args);
  let mcpClose = world.mcpClose;
  let httpRunner = world.httpRunner;

  try {
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
  } finally {
    // Close MCP/HTTP handles — the route never does (the step owns lifecycle).
    if (mcpClose) {
      try {
        await mcpClose();
      } catch {
        // ignore MCP close errors
      }
    }
    if (httpRunner) {
      try {
        await httpRunner.close();
      } catch {
        // ignore HTTP runner close errors
      }
    }
  }
}
