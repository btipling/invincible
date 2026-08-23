/**
 * backend-agents E (#791 / source #768) — PRODUCTION turn-worker seam.
 *
 * The `"use workflow"` orchestrator drives two `"use step"` bodies
 * (`runModelTurnStep` / `runWorkerPersistStep` in `turnWorkflow.ts`). A Workflows
 * step is a NEW Function, so NO client / sandbox / MCP / HTTP handle can survive a
 * step boundary (parent #764 decision B: "re-resolve every step, fail closed"). The
 * step body therefore re-resolves the FULL `/api/agent` resolve cascade through the
 * composition root (`createProdServices`) BEFORE each `runAgentStream` call and
 * closes every transport it opened before returning.
 *
 * THIS module is the production seam factory: `createTurnWorkerSeam(services)`
 * returns the `TurnStepRunSeam` whose `resolveRunParams(args, freshness)` reproduces
 * the route's resolution — BYOK, server secrets, per-user GitHub PAT, session-owned
 * sandbox bind, MCP tools, builtin HTTP, skills (always-on + sticky + command),
 * persona, read-only skill + meta authoring + sandbox meta tools — and returns a
 * `{ params, close() }` slice. `close()` releases the sandbox / MCP / HTTP runners
 * this cascade opened.
 *
 * The tested path (`lib/agent/turnWorkflow.test.ts`) drives the step bodies with a
 * mocking `TurnStepRunSeam`; this production seam is the real binding the started
 * workflow resolves INSIDE the step (never via serializable `start()` args — the
 * #710 lie is not re-introduced).
 *
 * Fail closed: any resolve rejection throws (the step maps it to an `error` event +
 * a run end); there is NO silent `/api/agent` fallback. Secrets/BYOK are resolved in
 * the step process and never written to Workflow state or args.
 */

import type {
  TurnStepRunSeam,
  TurnWorkflowArgs,
} from './turnWorkflow';
import type { RunFileFreshness } from './fileFreshness';
import type { RunAgentParams } from './runAgent';
import { createProdServices, type ServerSecrets } from '../di';
import { resolveSessionStore, sessionKeyFor } from '../tenancy/harnessSessionsRedis';
import { isEnvelopeStore } from '../sessions/sessionStore';
import { buildUserMcpTools } from '../mcp/client';
import { resolveBuiltinHttpConfig } from './builtinHttpConfig';
import { createHttpFetchTools } from './httpFetchTools';
import { createSkillTools } from './skillTools';
import { createMetaPersonaSkillTools, isMetaToolName } from './metaTools';
import { createMetaSandboxTools } from './metaSandboxTools';
import { resolvePersonaPreamble } from '../tenancy/personaInject';
import {
  parseSkillCommand,
  resolveSkillPreamble,
  type ResolveSkillResult,
} from '../tenancy/skillInject';

export type { TurnStepRunSeam };

/** The concrete run-params slice a production resolve returns (minus prompt/freshness). */
export type ResolvedRunParams = Omit<RunAgentParams, 'prompt' | 'freshness'>;

/** Resolve the server secrets + a redaction list for one model step. */
function baseRedact(serverSecrets: ServerSecrets, byokSecrets: string[]): string[] {
  return [...byokSecrets, serverSecrets.gatewayKey].filter(Boolean) as string[];
}

/**
 * Build the production `TurnStepRunSeam`. `services` is the composition root the
 * route / entry already constructed; the seam re-resolves through IT (the same
 * factories `/api/agent` uses) so grants/BYOK/sandbox/MCP/http are all fresh per step.
 */
export function createTurnWorkerSeam(
  services: ReturnType<typeof createProdServices> = createProdServices(),
): TurnStepRunSeam {
  return {
    async resolveRunParams(args: TurnWorkflowArgs, freshness: RunFileFreshness) {
      const { userId, sessionId, initialCwd, modelId: bodyModelId, tenantId } = args;
      const serverSecrets = services.serverSecrets;
      const httpRunnerClose: Array<() => Promise<void>> = [];

      // Resolve tenant → session key once; envelope reads (activeSandboxId bind,
      // persona snapshot, sticky attachedSkills) go through it. Fail open for non-
      // fatal store misses (like the route) — a missing envelope never 4xx's.
      const sessionStoreRes = await resolveSessionStore();
      const sessionStore =
        sessionStoreRes.ok && isEnvelopeStore(sessionStoreRes.value)
          ? sessionStoreRes.value
          : undefined;
      const sessionKey =
        sessionStore && tenantId && sessionId
          ? sessionKeyFor(tenantId, userId, sessionId)
          : undefined;

      // 1. BYOK → modelId + providerOptions + secrets to redact.
      const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
        userId,
        bodyModelId,
      );
      if (!byok.ok) {
        throw new Error(
          `turn worker BYOK resolve failed: ${
            byok.reason === 'unavailable'
              ? 'model catalog unavailable'
              : 'no usable model for this user'
          }`,
        );
      }
      let redactList = baseRedact(serverSecrets, byok.secretsToRedact ?? []);

      // 2. Per-user GitHub PAT → sandbox exec env (server-owned, never from the tool).
      let execEnv: Record<string, string> | undefined;
      const gh = await services.userGithubToken.decryptUserGithubTokenForServer(userId);
      if (gh.ok && gh.value) {
        redactList = [...redactList, gh.value];
        execEnv = { GH_TOKEN: gh.value, GITHUB_TOKEN: gh.value };
      }

      // 3. Session-owned active sandbox bind WINS over the body (envelope authoritative).
      let requestedSandboxId: string | undefined;
      if (sessionStore && sessionKey) {
        try {
          const envelope = await sessionStore.readEnvelope(sessionKey);
          const bound = envelope?.meta?.activeSandboxId;
          if (typeof bound === 'string' && bound) requestedSandboxId = bound;
        } catch {
          // fail-open: keep args.sandboxId
        }
      }

      // 4. Resolve the sandbox (grants + client + jail root). Route soft-path on
      //    softContinue / selectionRequired keeps the worker honest: it can still run
      //    with MCP/http/meta tools; a HARD denial throws (fail closed).
      const sandboxRes = await services.resolveSandbox.resolveAgentSandbox(
        userId,
        { ...(execEnv ? { execEnv } : {}) },
        {
          // A Workflow step has no request signal; the spread keeps the shape
          // the bound factory accepts (mirrors the route's call, which passes
          // requestedSandboxId through a spread over `signal`).
          signal: undefined,
          ...(requestedSandboxId ? { requestedSandboxId } : {}),
        },
      );
      let sandboxClient: ResolvedRunParams['sandboxClient'];
      let sandboxParams: Partial<ResolvedRunParams> = {};
      if (sandboxRes.ok) {
        sandboxClient = sandboxRes.value.client;
        redactList.push(...sandboxRes.value.secrets);
        sandboxParams = {
          sandboxClient,
          permissions: sandboxRes.value.permissions,
          workspaceRoot: sandboxRes.value.workspaceRoot,
          sandboxId: sandboxRes.value.sandboxId,
          bind: {
            backend: sandboxRes.value.backend,
            sandboxId: sandboxRes.value.sandboxId,
            name: sandboxRes.value.name,
            slug: sandboxRes.value.slug,
            status: sandboxRes.value.status,
            image: sandboxRes.value.resolvedImage,
          },
          secrets: [
            ...sandboxRes.value.secrets,
            ...(byok.secretsToRedact ?? []),
            ...(gh.ok && gh.value ? [gh.value] : []),
          ],
        };
      } else if (!sandboxRes.softContinue && !sandboxRes.selectionRequired) {
        throw new Error('turn worker sandbox resolve failed (no usable grant).');
      } else {
        sandboxParams = { skipSandboxTools: true, secrets: [...(byok.secretsToRedact ?? [])] };
      }

      // 5. MCP tools (always reconnect per step).
      const mcp = await buildUserMcpTools(userId, {
        loadSecrets: services.userMcpServers.loadEnabledUserMcpSecrets,
        setLastError: services.userMcpServers.setUserMcpServerLastError,
      });
      redactList.push(...mcp.secretsToRedact);
      if (mcp.close) httpRunnerClose.push(mcp.close);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let extraTools: Record<string, any> = { ...mcp.tools };

      // 6. Read-only skill + meta authoring + sandbox meta tools (always available).
      extraTools = {
        ...extraTools,
        ...createSkillTools({
          userId,
          userSkills: services.userSkills,
          userPersonas: services.userPersonas,
        }),
        ...createMetaPersonaSkillTools({
          userId,
          userPersonas: services.userPersonas,
          userSkills: services.userSkills,
        }),
        ...createMetaSandboxTools({
          userId,
          sessionId,
          userPreferredSandbox: services.userPreferredSandbox,
          sessionStoreSeam: {
            resolveSessionStore: () => resolveSessionStore(),
            resolveTenantIdForUser: (uid: string) =>
              services.harnessSessionsRedis.resolveTenantIdForUser(uid),
          },
        }),
      };

      // 7. Builtin HTTP runner when the user has a running Settings instance.
      let httpAttachName: string | null = null;
      try {
        const loaded = await services.userSandboxInstance.loadInstance(userId, 'http');
        if (loaded.ok && loaded.value && loaded.value.status === 'running')
          httpAttachName = loaded.value.vercelName?.trim() ?? null;
      } catch {
        httpAttachName = null;
      }
      if (httpAttachName) {
        const builtinHttp = resolveBuiltinHttpConfig();
        const httpRunner = services.createHttpRunner({ name: httpAttachName });
        httpRunnerClose.push(httpRunner.close ? () => httpRunner.close() : async () => {});
        extraTools = {
          ...extraTools,
          ...createHttpFetchTools({
            runner: httpRunner,
            secrets: redactList,
            serverSecrets,
            maxBytes: builtinHttp.maxBytes,
            timeoutMs: builtinHttp.timeoutMs,
          }),
        };
      }

      // 8. Persona preamble (fail-open like the route).
      let personaPreamble: string | undefined;
      try {
        if (sessionStore && sessionKey && sessionId) {
          personaPreamble = await resolvePersonaPreamble({
            userId,
            sessionId,
            sessionStore,
            sessionKey,
            userPersonas: services.userPersonas,
          });
        }
      } catch {
        personaPreamble = undefined;
      }

      // 9. Skills preamble (always-on + sticky + current command), fail-open.
      let skillsPreamble: string | undefined;
      let attachedSkills: string | undefined;
      try {
        let alwaysOnSlugs: string[] | undefined;
        const aores = await services.userSkills.listAlwaysOnSkills(userId);
        if (aores.ok) alwaysOnSlugs = aores.value.length > 0 ? aores.value : undefined;
        const pathSlug = parseSkillCommand(args.prompt);
        let skills: ResolveSkillResult | undefined;
        if (alwaysOnSlugs || sessionId) {
          skills = await resolveSkillPreamble({
            userId,
            command: pathSlug,
            userSkills: services.userSkills,
            alwaysOnSlugs,
            ...(sessionStore && sessionKey ? { sessionStore, sessionKey } : {}),
          });
        }
        skillsPreamble = skills?.preamble;
        attachedSkills = skills?.attachedSkills;
      } catch {
        // fail-open: no preamble
      }

      const base: ResolvedRunParams = {
        modelId: byok.modelId,
        providerOptions: {
          gateway: {
            only: byok.only as never,
            byok: byok.byok as never,
          },
        },
        secrets: redactList,
        initialCwd,
        serverSecrets,
        extraTools,
        ...sandboxParams,
        ...(personaPreamble ? { personaPreamble } : {}),
        ...(skillsPreamble ? { skillsPreamble } : {}),
      };

      return {
        params: base,
        async close() {
          await Promise.allSettled(
            httpRunnerClose.map((f) => Promise.resolve().then(f)),
          );
          // The sandbox client + MCP close are handled in the same `finally` as the
          // step body's writer release; the runner list covers http/MCP above.
          try {
            if (sandboxClient?.close) await sandboxClient.close();
          } catch {
            /* ignore */
          }
          for (const _ of [] as unknown[]) void _; // (no-op for lint determinism)
        },
      };
    },
  };
}
