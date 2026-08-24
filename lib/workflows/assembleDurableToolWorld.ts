/**
 * backend-agents C14b (#835) — shared in-step durable-tool-world assembly.
 *
 * EXACTLY ONE helper, used by both `modelGenerateStep` and `toolExecuteStep`,
 * so the worlds cannot drift. Assembles the full tool surface (sandbox FS +
 * skill/meta + MCP + builtin-HTTP) from serializable `scope` + `persistRunBind`,
 * matching `/api/agent`'s resolve path exactly.
 *
 * Called ONLY from `'use step'` files, which the B11 walker treats as leaves
 * (their imports are not followed into the workflow-entry closure). The DI
 * root / Blob / MCP / sandbox imports here are legal because the walker
 * never traverses past a `'use step'` directive.
 *
 * Production path (resolver UNSET): assembles the world in-step from scope.
 * Test path: steps may still inject via their module-level resolvers; this
 * helper is the fallback prod path.
 *
 * Return type distinguishes hard sandbox deny (grant policy — the requested
 * sandbox is forbidden/not-usable) from soft-path (operational unavailability /
 * selection-required / HTTP-attach bypass). Hard deny is a business error VALUE,
 * never a throw (SDK 3× retry must not fire on grant policy).
 */

import { buildToolWorld } from '../agent/buildToolWorld';
import {
  createRunFileFreshness,
  hydrateRunFileFreshness,
  type RunFileFreshness,
} from '../agent/fileFreshness';
import { createAgentTools } from '../agent/tools';
import type { HttpFetchRunner } from '../agent/httpFetchTypes';
import type { SandboxInfoBind } from '../agent/sandboxInfo';
import type { PersistRunBind } from './turnLoop';

/** Serializable args for the shared world assembly — plain values only. */
export type AssembleDurableToolWorldArgs = {
  /** Serializable session scope (tenant + user + session). */
  scope: { tenantId: string; userId: string; sessionId: string };
  /** Pre-run sandbox bind (cwd, activeSandboxId). Optional. */
  persistRunBind?: PersistRunBind;
  /** B5-serialized file-freshness seed to hydrate in-step (optional). */
  freshnessSeed?: string;
  /** Optional cancellation signal (defaults to a fresh AbortController). */
  signal?: AbortSignal;
};

/**
 * Assembled tool world — the same shape both steps consume.
 * `modelGenerateStep` only uses `registry` (schemas-only); `toolExecuteStep`
 * uses everything.
 */
export type DurableToolWorld = {
  /** The merged tool registry (FS + skill/meta + MCP + HTTP), with `execute` closures. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  /** Redaction secrets list. */
  secrets: Array<string | undefined | null>;
  /** Cancellation signal. */
  signal: AbortSignal;
  /**
   * Run-scoped file-freshness ledger — hydrated once from the seed (or a new
   * ledger when unseeded). The SAME object must be passed to both
   * `createAgentTools` and `executeTool` so read-before-edit grants survive
   * across the tool step (B5 freshness split fix).
   */
  freshness: RunFileFreshness;
  /** MCP close handle (no-op when no MCP surface). */
  mcpClose?: () => Promise<void>;
  /** Builtin-HTTP runner (present only when a running HTTP instance attached). */
  httpRunner?: HttpFetchRunner;
  /** Sandbox client close handle (present when a sandbox client was opened). */
  sandboxClientClose?: () => Promise<void>;
};

/**
 * Result of the shared world assembly.
 *
 * - `{ok:true, world}`: world assembled — may or may not include FS tools
 *   (soft-path → no FS; full path → FS merged).
 * - `{ok:false, code:'sandbox_forbidden'}`: hard deny — the requested sandbox
 *   is forbidden/not-usable AND no soft-path applies. Callers map this to
 *   their own error codes (modelGenerateStep → model_error, toolExecuteStep →
 *   sandbox_error) so the loop terminates cleanly.
 */
export type AssembleResult =
  | { ok: true; world: DurableToolWorld }
  | { ok: false; code: 'sandbox_forbidden'; error: string };

/**
 * Assemble the full durable tool world from serializable scope + bind.
 *
 * Byte-identical resolve order to `/api/agent`:
 * 1. Resolve GH token → execEnv
 * 2. Resolve sandbox (with requestedSandboxId from persistRunBind + execEnv)
 * 3. Resolve HTTP attach name
 * 4. Assemble non-FS world via C14a `buildToolWorld`
 * 5. Merge FS sandbox tools via `createAgentTools` (always, even when
 *    workspaceRoot is null — absolute paths fail closed, relative still work)
 *
 * Sandbox resolve matches `/api/agent`'s hard/soft deny policy exactly:
 * - `{ok:true}` → merge FS tools + pass non-secret `bind` for sandbox_info.
 * - `{ok:false}` + softContinue | selectionRequired | HTTP attach → no FS,
 *   continue with skill/meta/MCP/HTTP (soft-path).
 * - `{ok:false}` without those flags → HARD 403 (`{ok:false,
 *   code:'sandbox_forbidden'}`) — never silently drop a requested-but-unusable
 *   sandbox id. The helper returns this as a VALUE, not a throw.
 * - Operational throw (DB down, daemon fault) → soft-path (no FS).
 */
export async function assembleDurableToolWorld(
  args: AssembleDurableToolWorldArgs,
): Promise<AssembleResult> {
  const { userId, sessionId, tenantId } = args.scope;
  const signal = args.signal ?? new AbortController().signal;

  // Hydrate the B5 freshness ledger ONCE — the SAME object goes into both
  // createAgentTools (FS tools record reads) and executeTool (freshnessDelta
  // serializes the same ledger). Without this fix, createAgentTools gets a
  // NEW empty ledger while executeTool uses a different one, breaking
  // read-before-edit across the step boundary.
  const freshness: RunFileFreshness = args.freshnessSeed
    ? hydrateRunFileFreshness(args.freshnessSeed)
    : createRunFileFreshness();

  const { createProdServices } = await import('../di/index');
  const services = createProdServices();

  // 1. Resolve GH token for sandbox exec env + redaction.
  let ghToken: string | undefined;
  try {
    const gh = await services.userGithubToken.decryptUserGithubTokenForServer(userId);
    if (gh.ok && gh.value) {
      ghToken = gh.value;
    }
  } catch {
    // Fail-open: no GH token → no exec env.
  }

  // GH secrets for redaction.
  const ghSecrets: string[] = [];
  if (ghToken) ghSecrets.push(ghToken);

  // 2. Resolve HTTP attach name for builtin-HTTP tools (needed for the
  //    soft-path gate: an HTTP instance running is a valid soft surface even
  //    when sandbox resolve is a hard deny).
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

  // 3. Resolve sandbox (FS client + permissions + secrets).
  //    Pass `requestedSandboxId` from persistRunBind so the envelope bind wins.
  //    Pass `execEnv.GH_TOKEN` so sandbox exec has the user's GH PAT.
  let sandboxClient: import('../sandbox/client').SandboxClient | undefined;
  let sandboxSecrets: string[] = [];
  let permissions:
    | { canRead: boolean; canWrite: boolean }
    | undefined;
  let workspaceRoot: string | undefined;
  let sandboxClientClose: (() => Promise<void>) | undefined;
  /** Non-secret bind projection for sandbox_info (Minor). */
  let bind: SandboxInfoBind | undefined;

  const requestedSandboxId = args.persistRunBind?.activeSandboxId;
  try {
    const resolved = await services.resolveSandbox.resolveAgentSandbox(
      userId,
      { execEnv: ghToken ? { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } : undefined },
      { signal, requestedSandboxId },
    );

    if (resolved.ok) {
      sandboxClient = resolved.value.client;
      sandboxSecrets = resolved.value.secrets;
      permissions = resolved.value.permissions;
      workspaceRoot = resolved.value.workspaceRoot ?? undefined;
      if (typeof (resolved.value.client as { close?: () => Promise<void> }).close === 'function') {
        sandboxClientClose = () =>
          (resolved.value.client as { close: () => Promise<void> }).close();
      }
      bind = {
        backend: resolved.value.backend,
        sandboxId: resolved.value.sandboxId,
        name: resolved.value.name,
        slug: resolved.value.slug,
        status: resolved.value.status,
        image: resolved.value.resolvedImage,
      };
    } else {
      // Sandbox resolve returned {ok:false}. Match `/api/agent`'s hard/soft
      // deny policy exactly — never silently drop a requested-but-unusable id.
      // - softContinue / selectionRequired / HTTP attach → soft-path (no FS).
      // - otherwise → HARD 403 (return as VALUE, not throw).
      if (resolved.softContinue || resolved.selectionRequired || httpAttachName) {
        // Soft-path: no FS tools; MCP + builtin HTTP (+ meta_sandbox for
        // selectionRequired) still drive the turn.
        // Fall through to buildToolWorld without sandbox.
      } else {
        // Hard deny: requested sandbox is forbidden/not-usable and no soft
        // surface exists. Return as a business error VALUE (SDK must not
        // 3× retry grant policy).
        return {
          ok: false,
          code: 'sandbox_forbidden',
          error: 'Sandbox not available: the requested sandbox is not usable and no alternative tool surface is available.',
        };
      }
    }
  } catch {
    // Operational error (DB down, daemon fault, network) → soft-path.
    // Sandbox unavailable is NOT a grant decision — the turn still has
    // skill/meta/MCP/HTTP tools. Never 403 on an operational fault.
  }

  // Wrap assembly in try/catch: if buildToolWorld connects MCP/HTTP and then
  // createAgentTools throws, the handles leaked — they were never returned to
  // the caller and never closed. Close everything on the error path and
  // re-throw so the caller (modelGenerateStep / toolExecuteStep) can handle it.
  let world: Awaited<ReturnType<typeof buildToolWorld>> | undefined;
  try {
    // 4. Assemble the non-FS tool world (C14a).
    const { buildUserMcpTools } = await import('../mcp/client');
    const { resolveSessionStore } = await import(
      '../tenancy/harnessSessionsRedis'
    );

    world = await buildToolWorld({
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
      ...(sandboxClient
        ? { sandbox: { client: sandboxClient, secrets: sandboxSecrets } }
        : {}),
      httpAttachName,
    });

    // 5. Merge FS sandbox tools into the registry. Always merge when a sandbox
    //    client exists + permissions are known — NEVER skip on null workspaceRoot
    //    (BYO probe fault must not drop the tools; absolute paths fail closed,
    //    same as /api/agent).
    let registry = world.registry;
    if (sandboxClient && permissions) {
      const initialCwd = args.persistRunBind?.cwd;
      const fsTools = createAgentTools({
        client: sandboxClient,
        freshness,
        permissions,
        workspaceRoot: workspaceRoot ?? null,
        ...(initialCwd ? { initialCwd } : {}),
        ...(bind ? { bind } : {}),
        secrets: world.secrets,
        signal,
      });
      registry = { ...registry, ...fsTools };
    }

    return {
      ok: true,
      world: {
        registry,
        secrets: world.secrets,
        signal: world.signal,
        freshness,
        mcpClose: world.mcpClose,
        httpRunner: world.httpRunner,
        sandboxClientClose,
      },
    };
  } catch (err) {
    // Close any handles that were opened before the throw.
    // buildToolWorld may have connected MCP / opened HTTP before throwing;
    // createAgentTools may have thrown after buildToolWorld succeeded.
    if (world?.mcpClose) {
      try { await world.mcpClose(); } catch { /* ignore MCP close errors on the error path */ }
    }
    if (world?.httpRunner) {
      try { await world.httpRunner.close(); } catch { /* ignore HTTP runner close errors on the error path */ }
    }
    // Sandbox client was opened before buildToolWorld — close it too.
    if (sandboxClientClose) {
      try { await sandboxClientClose(); } catch { /* ignore sandbox close errors on the error path */ }
    }
    throw err;
  }
}
