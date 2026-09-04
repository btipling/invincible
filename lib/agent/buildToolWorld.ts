/**
 * C14a (#834) — shared one-tool-world assembly seam.
 *
 * Extracts the tool-world assembly that `/api/agent` used to build inline inside
 * its request handler into a dependency-injected, DI-gate-clean shared function:
 *
 *   buildToolWorld(scope) -> ToolWorld
 *
 * Byte-identical behavior to the old inline route assembly — a **pure
 * extraction, no behavior change**. C14a exists so the later `POST /api/turns`
 * route (C14+) can be a small consumer via `setToolWorldResolver`, and so the
 * strict soft-path deferral classes (`softContinue` / `selectionRequired` /
 * builtin-http attach) survive extraction exactly.
 *
 * `ToolWorld` is the assembled, one-tool world: the tool **registry** (the
 * always-on `createSkillTools` / `createMetaPersonaSkillTools` /
 * `createMetaSandboxTools`, merged with per-user MCP tools and builtin-HTTP
 * `http_get` when a running Settings HTTP instance exists), the **redaction
 * list**, the request **`AbortSignal`**, and the lifecycle handles (MCP close /
 * http runner). This is the same surface `setToolWorldResolver({... registry,
 * secrets, signal })` (`lib/workflows/toolExecuteStep.ts`) needs, plus what
 * `/api/agent` folds into `runParams`.
 *
 * The sandbox **registry** itself (`createAgentTools`, `lib/agent/tools.ts`) is
 * NOT assembled here — `runAgent` still does that from the injected
 * `sandboxClient` + `permissions` + `workspaceRoot` + `bind` (which the route
 * passes through on the FS path). This module owns the *non-FS* surface; the
 * two are merged inside `runAgent` exactly as before.
 *
 * Layering:
 * - **DI-gate clean.** All I/O handles / factories are injected via `scope` —
 *   never constructed in body. In particular the MCP builder
 *   (`buildUserMcpTools`, `lib/mcp/**` is B11-banned) and the HTTP runner
 *   factory (`services.createHttpRunner`) are injected handles, and the session
 *   store seam is passed as closures. No `createDbConnection(` / `new PGlite(` /
 *   sandbox/http/redis construction here.
 * - **No B11-banned static import.** This module does not import
 *   `lib/mcp/**`; it receives `buildUserMcpTools` as an injected function and
 *   resolves the builtin-HTTP config via the injected runner factory's caller.
 */
import type { ServerSecrets } from '../di';
import type { SandboxClient } from '../sandbox/client';
import type { HttpFetchRunner } from './httpFetchTypes';
import { resolveBuiltinHttpConfig } from './builtinHttpConfig';
import { createHttpFetchTools } from './httpFetchTools';
import { createSkillTools } from './skillTools';
import { createMetaPersonaSkillTools } from './metaTools';
import { createMetaSandboxTools } from './metaSandboxTools';
import { createWorkingNotesTools } from './workingNotesTools';
import type { SessionStoreSeam } from './metaSandboxTools';
import type {
  BuildUserMcpToolsOptions,
  BuildUserMcpToolsResult,
} from '../mcp/client';
import type { createUserSkills } from '../tenancy/userSkills';
import type { createUserPersonas } from '../tenancy/userPersonas';

/** Post-assembly tool world the route / C14 engine folds into runParams. */
export type ToolWorld = {
  /**
   * The one-tool registry (the merged non-FS `extraTools`):
   * all always-on skill/meta tools + per-user MCP + builtin-HTTP when attached.
   * `runAgent` merges the FS `createAgentTools` registry into this internally.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  /** Final runParams.secrets (byok + gh + sandbox-on-FS + mcp), in assembly order. */
  secrets: Array<string | undefined | null>;
  /** Final server redaction list (byok + gateway + gh + sandbox-on-FS + mcp). */
  redactList: string[];
  /** Request `AbortSignal` carried through to tools + runner. */
  signal: AbortSignal;
  /** MCP close handle (no-op when no MCP surface); caller owns lifecycle. */
  mcpClose?: () => Promise<void>;
  /** Builtin-HTTP runner (present only when a running HTTP instance attached). */
  httpRunner?: HttpFetchRunner;
};

/** DI seam slice `buildToolWorld` needs off `services` (narrow, never constructed). */
export type BuildToolWorldServices = {
  userSkills: ReturnType<typeof createUserSkills>;
  userPersonas: ReturnType<typeof createUserPersonas>;
  userPreferredSandbox: Parameters<
    typeof createMetaSandboxTools
  >[0]['userPreferredSandbox'];
  userMcpServers: {
    loadEnabledUserMcpSecrets: NonNullable<
      BuildUserMcpToolsOptions['loadSecrets']
    >;
    setUserMcpServerLastError: NonNullable<
      BuildUserMcpToolsOptions['setLastError']
    >;
  };
  createHttpRunner: (opts: { name: string }) => HttpFetchRunner;
};

export type BuildToolWorldScope = {
  /** Caller-owned user id (bound into every tool's identity closure). */
  userId: string;
  /** Caller-owned session id (Redis-safe opaque) — for `meta_sandbox_switch`. */
  sessionId?: string;
  /** Request `AbortSignal`. */
  signal: AbortSignal;
  /** Root-resolved server secrets (phase-2 DI). */
  serverSecrets: ServerSecrets;
  /** DI seam (never constructed in body). */
  services: BuildToolWorldServices;
  /** Session-store seam for the meta-sandbox switch envelope write. */
  sessionStoreSeam: SessionStoreSeam;
  /**
   * Injected MCP builder. `lib/mcp/**` is B11-banned from this module's static
   * imports, so the caller (the route / C14 engine) supplies it. Returns the
   * MCP tool map + redaction + close handle.
   */
  buildUserMcpTools: (
    userId: string,
    opts?: BuildUserMcpToolsOptions,
  ) => Promise<BuildUserMcpToolsResult>;
  /** Request-scoped BYOK + GitHub-PAT secrets (before sandbox fold). */
  byokSecretsToRedact: string[];
  ghSecrets: string[];
  /**
   * Resolved FS sandbox surface. Present ONLY on the FS-ok path — on the
   * soft/no-FS path the route passes `undefined` (no FS secrets folded).
   */
  sandbox?: {
    client: SandboxClient;
    secrets: string[];
  };
  /** Attachable Settings HTTP instance name (trimmed) or null. */
  httpAttachName: string | null;
};

/**
 * Assemble the one-tool world for a turn. Byte-identical to `/api/agent`'s
 * former inline assembly (registry merge / redact-list / secrets order
 * preserved exactly). Returns the registry + lifecycle for the route to fold.
 */
export async function buildToolWorld(
  scope: BuildToolWorldScope,
): Promise<ToolWorld> {
  const {
    userId,
    sessionId,
    signal,
    serverSecrets,
    services,
    sessionStoreSeam,
    buildUserMcpTools,
    byokSecretsToRedact,
    ghSecrets,
    sandbox,
    httpAttachName,
  } = scope;

  // --- always-on tool families (independent of sandbox/MCP/http state) -------

  // Phase 3 (#516): read-only agent skill tools (`find_skill` / `fetch_skill`).
  let extraTools: Record<string, any> = {
    ...createSkillTools({
      userId,
      userSkills: services.userSkills,
      userPersonas: services.userPersonas,
    }),
  };

  // Phase 1 (#531): first-party persona + skill AUTHORING tools (`meta_*`).
  extraTools = {
    ...extraTools,
    ...createMetaPersonaSkillTools({
      userId,
      userPersonas: services.userPersonas,
      userSkills: services.userSkills,
    }),
  };

  // Phase 2 (#532): first-party SANDBOX meta tools (`meta_sandbox_*`), with the
  // envelope-switch persist seam injected (never constructed here).
  extraTools = {
    ...extraTools,
    ...createMetaSandboxTools({
      userId,
      sessionId,
      userPreferredSandbox: services.userPreferredSandbox,
      sessionStoreSeam,
    }),
  };

  // Plan #938: first-party working-notes tools (`working_notes_*`) — the only
  // writers of the session-owned `meta.workingNotes` block. Assembled AFTER
  // `meta_*` and BEFORE the FS/tool-registry merge (mirroring `meta_*`) so both
  // `/api/agent` and `assembleDurableToolWorld` (durable turns) inherit them.
  extraTools = {
    ...extraTools,
    ...createWorkingNotesTools({
      userId,
      sessionId,
      sessionStoreSeam,
    }),
  };

  // --- redaction + runParams.secrets accumulation (assembly order preserved) --

  const redactList: string[] = [
    ...byokSecretsToRedact,
    serverSecrets.gatewayKey,
  ].filter(Boolean) as string[];
  redactList.push(...ghSecrets);

  // runParams.secrets seed mirrors the route: on the FS path the sandbox
  // secrets come FIRST (then byok, then gh); on the soft path no sandbox fold.
  const secretsBase: Array<string | undefined | null> = [
    ...(sandbox?.secrets ?? []),
    ...byokSecretsToRedact,
    ...ghSecrets,
  ];
  if (sandbox) {
    redactList.push(...sandbox.secrets);
  }

  // --- per-user MCP tools -----------------------------------------------------

  const mcp = await buildUserMcpTools(userId, {
    signal,
    loadSecrets: services.userMcpServers.loadEnabledUserMcpSecrets,
    setLastError: services.userMcpServers.setUserMcpServerLastError,
  });

  // Wrap the post-MCP assembly in try/catch: if we connected MCP and then
  // a later line throws (e.g. resolveBuiltinHttpConfig or createHttpRunner),
  // the MCP handle leaks — it was never returned to the caller. Close MCP +
  // HTTP on the error path and re-throw.
  let httpRunner: HttpFetchRunner | undefined;
  try {
    extraTools = { ...extraTools, ...mcp.tools };
    redactList.push(...mcp.secretsToRedact);
    const secrets = [...secretsBase, ...mcp.secretsToRedact];

    // --- builtin HTTP (only when a running Settings HTTP instance attaches)

    if (httpAttachName) {
      const builtinHttp = resolveBuiltinHttpConfig();
      // Constructed via the route's composition root (phase-2 DI), request-scoped.
      httpRunner = services.createHttpRunner({ name: httpAttachName });
      const httpTools = createHttpFetchTools({
        runner: httpRunner,
        secrets,
        serverSecrets,
        signal,
        maxBytes: builtinHttp.maxBytes,
        timeoutMs: builtinHttp.timeoutMs,
      });
      extraTools = { ...extraTools, ...httpTools };
    }

    return {
      registry: extraTools,
      secrets,
      redactList,
      signal,
      mcpClose: mcp.close,
      ...(httpRunner ? { httpRunner } : {}),
    };
  } catch (err) {
    // Close MCP handle if we connected before throwing.
    try { await mcp.close(); } catch { /* ignore MCP close errors on the error path */ }
    // Close HTTP runner if it was created before the throw.
    if (httpRunner) {
      try { await httpRunner.close(); } catch { /* ignore HTTP runner close errors on the error path */ }
    }
    throw err;
  }
}
