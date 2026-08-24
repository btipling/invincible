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
 */

import { buildToolWorld } from '../agent/buildToolWorld';
import {
  createRunFileFreshness,
  hydrateRunFileFreshness,
  type RunFileFreshness,
} from '../agent/fileFreshness';
import { createAgentTools } from '../agent/tools';
import type { HttpFetchRunner } from '../agent/httpFetchTypes';
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
 * FS tools are merged WHENEVER a sandbox client exists + permissions are known
 * (never skip on null workspaceRoot — BYO probe faults must not drop the tools;
 * absolute paths fail closed, same as `/api/agent`).
 */
export async function assembleDurableToolWorld(
  args: AssembleDurableToolWorldArgs,
): Promise<DurableToolWorld> {
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

  // 2. Resolve sandbox (FS client + permissions + secrets).
  //    Pass `requestedSandboxId` from persistRunBind so the envelope bind wins.
  //    Pass `execEnv.GH_TOKEN` so sandbox exec has the user's GH PAT.
  let sandboxClient: import('../sandbox/client').SandboxClient | undefined;
  let sandboxSecrets: string[] = [];
  let permissions:
    | { canRead: boolean; canWrite: boolean }
    | undefined;
  let workspaceRoot: string | undefined;
  let sandboxClientClose: (() => Promise<void>) | undefined;

  const requestedSandboxId = args.persistRunBind?.activeSandboxId;
  try {
    const resolved = await services.resolveSandbox.resolveAgentSandbox(
      userId,
      { execEnv: ghToken ? { GH_TOKEN: ghToken } : undefined },
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
    }
  } catch {
    // Sandbox unavailable — soft-path (no FS tools). The turn still has
    // skill/meta/MCP/HTTP tools.
  }

  // GH secrets for redaction.
  const ghSecrets: string[] = [];
  if (ghToken) ghSecrets.push(ghToken);

  // 3. Resolve HTTP attach name for builtin-HTTP tools.
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

  // 4. Assemble the non-FS tool world (C14a).
  const { buildUserMcpTools } = await import('../mcp/client');
  const { resolveSessionStore } = await import(
    '../tenancy/harnessSessionsRedis'
  );

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
      secrets: world.secrets,
      signal,
    });
    registry = { ...registry, ...fsTools };
  }

  return {
    registry,
    secrets: world.secrets,
    signal: world.signal,
    freshness,
    mcpClose: world.mcpClose,
    httpRunner: world.httpRunner,
    sandboxClientClose,
  };
}
