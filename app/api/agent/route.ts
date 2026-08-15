import type { JSONValue } from 'ai';
import {
  gatewayConfigured,
  mapByokResolveFailure,
  mapInferenceError,
  missingGatewayKeyError,
} from '../../../lib/chatServer';
import { parseAgentBody } from '../../../lib/agent/agentBody';
import type { SandboxClient } from '../../../lib/sandbox/client';
import { runAgent, runAgentStream } from '../../../lib/agent/runAgent';
import {
  AGENT_STREAM_CONTENT_TYPE,
  encodeSseData,
  wantsAgentStream,
  type AgentStreamEvent,
} from '../../../lib/agent/agentStream';
import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { redactSecrets } from '../../../lib/agent/redact';
import { buildUserMcpTools } from '../../../lib/mcp/client';
import { resolveBuiltinHttpConfig } from '../../../lib/agent/builtinHttpConfig';
import { createHttpFetchTools } from '../../../lib/agent/httpFetchTools';
import type { HttpFetchRunner } from '../../../lib/agent/httpFetchTypes';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../../../lib/tenancy/harnessSessionsRedis';
import { resolvePersonaPreamble } from '../../../lib/tenancy/personaInject';
import {
  parseSkillCommand,
  resolveSkillPreamble,
  type ResolveSkillResult,
} from '../../../lib/tenancy/skillInject';
import { isEnvelopeStore } from '../../../lib/sessions/sessionStore';
import { createSkillTools } from '../../../lib/agent/skillTools';
import {
  createMetaPersonaSkillTools,
  isMetaToolName,
} from '../../../lib/agent/metaTools';
import { createMetaSandboxTools } from '../../../lib/agent/metaSandboxTools';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m). 3600s is not offered.
export const maxDuration = 1800;

/** Phase-1 DI: services wired at the composition root (module never constructs). */
const services = createProdServices();

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'ResponseAborted';
}

/** Short confirmation text for a no-model skill turn (attach-only / detach). */
function summarizeSkillEvents(
  events: ResolveSkillResult['events'],
): string {
  const parts = events.map((e) => {
    if (e.action === 'attach') {
      return e.ok ? `attached ${e.slug}` : `could not attach ${e.slug}`;
    }
    return e.ok ? `detached ${e.slug}` : `could not detach ${e.slug}`;
  });
  return parts.join('; ');
}

/**
 * Release runners: hop-B http sandbox, MCP sessions, and FS SandboxClient.
 * Attach FS/HTTP close = extendTimeout + drop handle (never stop).
 * Called from JSON finally, stream start finally, and stream cancel.
 */
async function closeRunners(
  httpRunner: HttpFetchRunner | undefined,
  mcpClose: (() => Promise<void>) | undefined,
  sandboxClient?: SandboxClient | undefined,
): Promise<void> {
  if (sandboxClient?.close) {
    try {
      await sandboxClient.close();
    } catch {
      // ignore sandbox client close errors
    }
  }
  if (httpRunner) {
    try {
      await httpRunner.close();
    } catch {
      // ignore http runner close errors
    }
  }
  if (mcpClose) {
    try {
      await mcpClose();
    } catch {
      // ignore MCP close errors
    }
  }
}

/**
 * Multi-step agent with sandbox tools (+ builtin HTTP + per-user MCP when enabled).
 *
 * POST { prompt: string, modelId?: string, cwd?: string }
 * → JSON { text, toolTrace?, cwd? } | { error }
 * Omitted/null cwd → ".".
 * → or SSE (Accept: text/event-stream) agent events (docs/agent-stream.md)
 *
 * Always multi-tenant on: session user required, DB-resolved sandbox + grants +
 * request-scoped BYOK + user MCP tools. Builtin HTTP: BUILTIN_HTTP_FETCH=sandbox +
 * Settings HTTP instance attach; never create on the hot path.
 */
export async function POST(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }

  if (!gatewayConfigured()) {
    const { status, error } = missingGatewayKeyError();
    return Response.json({ error }, { status });
  }

  const builtinHttp = resolveBuiltinHttpConfig();
  const stream = wantsAgentStream(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected { prompt: string }.' },
      { status: 400 },
    );
  }

  const parsed = parseAgentBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  // Phase 2 (#517) — leading-slash skill commands. Parse the command, strip the
  // `/slug` prefix from the model prompt (keep remaining prose), or mark a pure
  // detach (`/unskill slug` consumes the whole line → no model turn).
  const skillCommand = parseSkillCommand(parsed.prompt);
  const modelPrompt =
    skillCommand.type === 'attach'
      ? skillCommand.rest
      : skillCommand.type === 'detach'
        ? ''
        : parsed.prompt;

  // Map skill outcomes to the display-only SSE event shape (slug only — never a
  // body). Every skill_attached event of a turn carries the SAME final
  // `attachedSlugs` set (Nit L6) so the host applies it last-writes-wins and can
  // persist it as sticky `meta.attachedSkills` on the next PUT — the host-carrier
  // that stops a host PUT from ever wiping the set (adversarial-review Blocker).
  const skillToEvent = (
    e: ResolveSkillResult['events'][number],
  ): AgentStreamEvent => ({
    type: 'skill_attached',
    slug: e.slug,
    action: e.action,
    ok: e.ok,
    ...(e.ok ? {} : { reason: e.reason }),
    ...(skills ? { attachedSlugs: skills.attachedSlugs } : {}),
  });

  // Server secrets resolved once at the root (phase-2 DI) — scrubbed from
  // model-facing and client-facing strings like the BYOK / PAT / MCP secrets.
  const serverSecrets = services.serverSecrets;

  // Hoisted so `skillToEvent` (defined above) can fold the final sticky set onto
  // every `skill_attached` event; assigned inside the try block below.
  let skills: ResolveSkillResult | undefined;

  let redactList: string[] = [];
  let mcpClose: (() => Promise<void>) | undefined;
  let httpRunner: HttpFetchRunner | undefined;
  let sandboxClient: SandboxClient | undefined;
  let runnersOwnedByStream = false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extraTools: Record<string, any> = {};
    // Accumulates request fields + resolved tool wiring; modelId is only known
    // after `resolveByokForRequest` returns, so it is added later (guarded below).
    type RunParamsAcc = Omit<Parameters<typeof runAgent>[0], 'modelId'> & {
      modelId?: string;
    };
    let runParams: RunParamsAcc = {
      prompt: modelPrompt,
      signal: req.signal,
      initialCwd: parsed.cwd,
      serverSecrets,
    };
    /**
     * When resolve fails but we soft-path (softContinue / selectionRequired /
     * builtin HTTP), keep the 403 body and return it only if no valid soft
     * surface assembles later.
     */
    let deferredNoFsResponse: Response | undefined;
    /**
     * True when the deferred 403 is the SELECTION-REQUIRED class (multiple usable
     * sandboxes, no bound/preferred id). In that class the always-present
     * `meta_sandbox_*` tools are a LEGITIMATE soft surface: the agent lists the
     * usable grants and switches (blocker B3 reachability). Distinguishes it from
     * every OTHER deferral (workspace-not-running softContinue, builtin-http grant
     * deny) where meta tools must NOT substitute for a real non-FS surface.
     */
    let metaSelectionDeferred = false;

    const userId = sessionGate.user?.id;
    if (!userId) {
      const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
      return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
    }

    // Phase 3 (#516): read-only agent skill tools (`find_skill` / `fetch_skill`)
    // — always available, independent of sandbox/MCP/http state (so they work on
    // the soft/MCP path too). Bound identity: each tool is closed over this
    // route-resolved `userId`; any identity a model passes is ignored. Read-only
    // — they call only listUserSkills / getSkillBySlug, never a write path.
    extraTools = {
      ...extraTools,
      ...createSkillTools({ userId, userSkills: services.userSkills }),
    };

    // Phase 1 (#531): first-party persona + skill AUTHORING tools
    // (`meta_persona_*` / `meta_skill_*`) — always available, independent of
    // sandbox state (like the read-only skill tools). Bound identity: each tool
    // is closed over this route-resolved `userId`; any identity a model passes
    // is ignored. Author-as-user (same grants as Settings); bodies returned
    // only on an explicit read, capped; no secrets.
    extraTools = {
      ...extraTools,
      ...createMetaPersonaSkillTools({
        userId,
        userPersonas: services.userPersonas,
        userSkills: services.userSkills,
      }),
    };

    // Phase 2 (#532): first-party SANDBOX meta tools (`meta_sandbox_list` /
    // `meta_sandbox_active` / `meta_sandbox_switch`) — always available. Bound
    // identity: each tool is closed over this route-resolved `userId`; switch
    // persistence writes ONLY the caller's own `sessionId` (`parsed.sessionId`)
    // via the session-store envelope seam (fail-closed on an unusable grant or
    // unavailable store — never a partial write). No secrets in any result.
    extraTools = {
      ...extraTools,
      ...createMetaSandboxTools({
        userId,
        sessionId: parsed.sessionId,
        userPreferredSandbox: services.userPreferredSandbox,
        sessionStoreSeam: {
          resolveSessionStore: () => resolveSessionStore(),
          resolveTenantIdForUser: (uid: string) =>
            services.harnessSessionsRedis.resolveTenantIdForUser(uid),
        },
      }),
    };

    // Persona injection (phase 3, #488): resolve the persona preamble for the
    // first agent turn from a locked `meta.personaSnapshot` (via the optional
    // Redis-safe `sessionId` seam) or a bound `personaId` (body or `meta.personaId`),
    // persisting the snapshot once. Fail-open: any resolution/store error → no
    // preamble (turn proceeds exactly as today), never a 4xx/5xx on the hot path.
    let personaPreamble: string | undefined;
    if (parsed.sessionId || parsed.personaId) {
      try {
        const tenantRes = await services.harnessSessionsRedis.resolveTenantIdForUser(
          userId,
        );
        if (tenantRes.ok) {
          const storeRes = await resolveSessionStore();
          const sessionStore = storeRes.ok ? storeRes.value : undefined;
          personaPreamble = await resolvePersonaPreamble({
            userId,
            sessionId: parsed.sessionId,
            personaId: parsed.personaId,
            ...(sessionStore && parsed.sessionId
              ? {
                  sessionStore,
                  sessionKey: sessionKeyFor(
                    tenantRes.value,
                    userId,
                    parsed.sessionId,
                  ),
                }
              : {}),
            userPersonas: services.userPersonas,
          });
        }
      } catch {
        personaPreamble = undefined;
      }
    }

    // Phase 2 (#517) — resolve attached skills (sticky re-read from
    // `meta.attachedSkills` + the current `/slug` attach or `/unskill` detach).
    // Modeled on personaInject but WITHOUT the snapshot lock: skills are
    // staff-of-work, so bodies re-resolve from the store each turn (edits apply
    // next turn). Fail-open: any store/resolution error → no preamble (turn
    // proceeds), never a 4xx/5xx on the hot path. Sticky persist is best-effort;
    // when no `sessionId`/store is available the attach still injects THIS turn
    // (mirrors persona's offline-safe path), just without a sticky write.
    // The store is narrowed to the phase-0 ENVELOPE seam (adversarial-review
    // H2): the agent mirror writes `readEnvelope`/`upsertEnvelope` so it lands on
    // the same `harness:envelope:*` key the host writes, never legacy `get`/`put`.
    if (skillCommand.type !== 'none' || parsed.sessionId) {
      try {
        const tenantRes = await services.harnessSessionsRedis.resolveTenantIdForUser(
          userId,
        );
        if (tenantRes.ok) {
          const storeRes = await resolveSessionStore();
          const sessionStore =
            storeRes.ok && isEnvelopeStore(storeRes.value)
              ? storeRes.value
              : undefined;
          skills = await resolveSkillPreamble({
            userId,
            command: skillCommand,
            userSkills: services.userSkills,
            ...(sessionStore && parsed.sessionId
              ? {
                  sessionStore,
                  sessionKey: sessionKeyFor(
                    tenantRes.value,
                    userId,
                    parsed.sessionId,
                  ),
                }
              : {}),
          });
        }
      } catch {
        skills = undefined;
      }
    }

    // A pure `/slug` attach with no remaining prose, or a `/unskill` detach, is
    // a NO-MODEL turn: emit the display-only `skill_attached` rows + a short
    // confirmation, never call the model with an empty prompt.
    if (!modelPrompt.trim()) {
      const text =
        summarizeSkillEvents(skills?.events ?? []) || 'No prompt to send.';
      const sseEvents = (skills?.events ?? []).map(skillToEvent);
      const skillEvents = skills?.events?.length ? skills.events : undefined;
      const attachedSkills = skills?.attachedSkills;
      if (stream) {
        const encoder = new TextEncoder();
        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const ev of sseEvents) {
              controller.enqueue(encoder.encode(encodeSseData(ev)));
            }
            controller.enqueue(encoder.encode(encodeSseData({ type: 'done', text })));
            controller.close();
          },
        });
        return new Response(bodyStream, {
          status: 200,
          headers: {
            'Content-Type': AGENT_STREAM_CONTENT_TYPE,
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      return Response.json({
        text,
        ...(skillEvents ? { skillEvents } : {}),
        ...(attachedSkills ? { attachedSkills } : {}),
      });
    }

    const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
      userId,
      parsed.modelId,
    );
    if (!byok.ok) {
      const { status, error } = mapByokResolveFailure(byok.reason);
      // Phase 2 (#517 / review residual): a BYOK 4xx AFTER skill resolution must
      // still carry the current sticky set, so the host folds it before persisting
      // — otherwise a host PUT without slugs can wipe the blob copy of a skill that
      // was attached this turn (the envelope mirror still has it, but GET may not).
      return Response.json(
        {
          error,
          ...(skills?.attachedSkills ? { attachedSkills: skills.attachedSkills } : {}),
        },
        { status },
      );
    }
    redactList = [
      ...byok.secretsToRedact,
      serverSecrets.gatewayKey,
    ].filter(Boolean) as string[];

    // Per-user GitHub PAT → sandbox exec env (client options only; never tool schema).
    const gh = await services.userGithubToken.decryptUserGithubTokenForServer(
      userId,
    );
    const ghSecrets: string[] = [];
    let execEnv: Record<string, string> | undefined;
    if (gh.ok && gh.value) {
      ghSecrets.push(gh.value);
      execEnv = { GH_TOKEN: gh.value, GITHUB_TOKEN: gh.value };
    }
    redactList = [...redactList, ...ghSecrets];

    // Phase 2 (#532 / blocker B1 A1): server-authoritative bind seed. The switch
    // tool persists `meta.activeSandboxId` on the caller's envelope; the route
    // MUST read it back to seed this turn's resolve so a switch survives the next
    // turn (previously only the body-provided `parsed.sandboxId` was honored —
    // the whole reason the switch never persisted). Per approved decision 3, when
    // a `sessionId` is present the server envelope bind WINS over the body
    // `sandboxId` (the host body is a mirror; the envelope is authoritative). The
    // body remains the fallback when the envelope carries no bind (or the store
    // is unavailable — fail-open: a resolve-read error never 4xx's the turn).
    // Set-but-unusable in the envelope fails closed via resolveSandbox's existing
    // grant-honesty 403; an unusable id is never silently dropped.
    let requestedSandboxId = parsed.sandboxId;
    if (parsed.sessionId) {
      try {
        const tenantRes =
          await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
        if (tenantRes.ok) {
          const storeRes = await resolveSessionStore();
          const store =
            storeRes.ok && isEnvelopeStore(storeRes.value)
              ? storeRes.value
              : undefined;
          if (store) {
            const envelope = await store.readEnvelope(
              sessionKeyFor(tenantRes.value, userId, parsed.sessionId),
            );
            const bound = envelope?.meta?.activeSandboxId;
            if (typeof bound === 'string' && bound) {
              requestedSandboxId = bound;
            }
          }
        }
      } catch {
        // Fail-open: keep the body fallback below.
        requestedSandboxId = parsed.sandboxId;
      }
    }

    const resolved = await services.resolveSandbox.resolveAgentSandbox(
      userId,
      { ...(execEnv ? { execEnv } : {}) },
      {
        // Pass the request abort signal so the health probe that discovers the
        // per-binding workspace root (run AFTER the DB connection is released)
        // cancels when the request is aborted — never a zombie probe.
        signal: req.signal,
        // Session-owned active sandbox override (Redis-safe, server-validated).
        // Envelope-seeded above (B1 A1); unset → today's preference/single/
        // selection logic; set-but-unusable → same 403 class (fail closed, no
        // silent fallback).
        ...(requestedSandboxId ? { requestedSandboxId } : {}),
      },
    );

    // When resolve fails, distinguish the soft-path classes from a hard 403:
    //  - `softContinue` (Workspace not running) → proceed only if MCP / builtin
    //    HTTP supply a real non-FS tool surface later.
    //  - `selectionRequired` (multiple usable sandboxes, no bound/preferred id) →
    //    proceed only if the agent's `meta_sandbox_*` tools are present, so it can
    //    self-select (blocker B3 reachability — previously a dead-end operator 403
    //    right when the agent MUST pick among usable grants).
    //  - builtin HTTP enabled → grant-deny still proceeds with HTTP-only tools.
    //  - otherwise → hard 403 (forbidden / bad grant / unusable id, no heal surface).
    if (!resolved.ok) {
      if (resolved.softContinue || resolved.selectionRequired || builtinHttp.enabled) {
        // Soft path: no FS tools; MCP + builtin HTTP (+ for selectionRequired the
        // meta_sandbox tools) may still drive the turn.
        runParams = {
          ...runParams,
          skipSandboxTools: true,
          secrets: [...byok.secretsToRedact, ...ghSecrets],
        };
        deferredNoFsResponse = resolved.response;
        if (resolved.selectionRequired) metaSelectionDeferred = true;
      } else {
        // Hard 403: grant/membership/selection without alternative soft path.
        return resolved.response;
      }
    } else {
      sandboxClient = resolved.value.client;
      redactList = [...redactList, ...resolved.value.secrets];
      runParams = {
        ...runParams,
        sandboxClient: resolved.value.client,
        permissions: resolved.value.permissions,
        // Per-binding jail workspace root (BYO daemon root or Vercel
        // workspace). Forwarded into createAgentTools so in-jail absolute tool
        // paths canonicalize to workspace-relative freshness keys (BYO+Vercel
        // parity). null on a faulting BYO probe — absolute then fails closed.
        workspaceRoot: resolved.value.workspaceRoot,
        // Reflect the authoritative resolved bind so the host can reconcile
        // after the turn (also surfaced on the `done` stream event).
        sandboxId: resolved.value.sandboxId,
        secrets: [
          ...resolved.value.secrets,
          ...byok.secretsToRedact,
          ...ghSecrets,
        ],
      };
    }

    const mcp = await buildUserMcpTools(userId, {
      signal: req.signal,
      loadSecrets: services.userMcpServers.loadEnabledUserMcpSecrets,
      setLastError: services.userMcpServers.setUserMcpServerLastError,
    });
    mcpClose = mcp.close;
    redactList = [...redactList, ...mcp.secretsToRedact];
    extraTools = { ...extraTools, ...mcp.tools };

    runParams = {
      ...runParams,
      modelId: byok.modelId,
      providerOptions: {
        gateway: {
          only: byok.only as JSONValue,
          byok: byok.byok as JSONValue,
        },
      },
      secrets: [
        ...(runParams.secrets ?? []),
        ...mcp.secretsToRedact,
      ],
    };

    if (builtinHttp.enabled) {
      let httpAttachName: string | undefined;

      // Settings HTTP/curl instance — omit tools when missing/stopped/error.
      const loaded = await services.userSandboxInstance.loadInstance(
        userId,
        'http',
      );
      if (
        loaded.ok &&
        loaded.value &&
        loaded.value.status === 'running' &&
        loaded.value.vercelName?.trim()
      ) {
        httpAttachName = loaded.value.vercelName.trim();
      }

      if (httpAttachName) {
        // Constructed via the composition root (phase-2 DI), request-scoped.
        httpRunner = services.createHttpRunner({ name: httpAttachName });
        const httpTools = createHttpFetchTools({
          runner: httpRunner,
          secrets: runParams.secrets,
          serverSecrets,
          signal: req.signal,
          maxBytes: builtinHttp.maxBytes,
          timeoutMs: builtinHttp.timeoutMs,
        });
        extraTools = { ...extraTools, ...httpTools };
      }
    }

    runParams = { ...runParams, extraTools };

    // Model id always resolved via BYOK above; guard so runAgent sees a required value.
    if (!runParams.modelId) {
      const { INFERENCE_MODEL_REQUIRED_ERROR } = await import(
        '../../../lib/tenancy/errors'
      );
      return Response.json(
        { error: INFERENCE_MODEL_REQUIRED_ERROR },
        { status: 400 },
      );
    }
    const finalRunParams: Parameters<typeof runAgent>[0] = {
      ...runParams,
      modelId: runParams.modelId,
      ...(personaPreamble ? { personaPreamble } : {}),
      ...(skills?.preamble ? { skillsPreamble: skills.preamble } : {}),
    };

    // Soft path only when a REAL tool surface exists to justify it:
    //  - For SELECTION-REQUIRED deferrals the always-present `meta_sandbox_*` tools
    //    ARE that surface — the agent lists the usable grants and switches (blocker
    //    B3 reachability), so we proceed when they're present.
    //  - For every OTHER deferral (workspace-not-running softContinue, grant-deny
    //    via builtin http) the always-on read-only skill + meta authoring tools do
    //    NOT count as a substitute: without FS, MCP, or http tools we must still
    //    surface the deferred 403 (workspace-required / no grant) rather than
    //    silently running a skill-only turn that hides the unavailable sandbox.
    const hasMetaSandboxTools = Object.keys(extraTools).some((k) =>
      k.startsWith('meta_sandbox_'),
    );
    const nonSkillToolCount = Object.keys(extraTools).filter(
      (k) => k !== 'find_skill' && k !== 'fetch_skill' && !isMetaToolName(k),
    ).length;
    if (deferredNoFsResponse && !sandboxClient) {
      const canProceed = metaSelectionDeferred
        ? hasMetaSandboxTools
        : nonSkillToolCount > 0;
      if (!canProceed) return deferredNoFsResponse;
    }

    if (stream) {
      runnersOwnedByStream = true;
      const encoder = new TextEncoder();
      const httpRef = httpRunner;
      const mcpRef = mcpClose;
      const sandboxRef = sandboxClient;
      const secretsForErr = redactList;

      const bodyStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;
          const enqueue = (ev: AgentStreamEvent) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(encodeSseData(ev)));
            } catch {
              closed = true;
            }
          };
          try {
            // Phase 2 (#517): emit the display-only `skill_attached` events at the
            // START of the turn (before the model runs) so the host paints the
            // skill-name row immediately.
            if (skills?.events?.length) {
              for (const ev of skills.events) enqueue(skillToEvent(ev));
            }
            await runAgentStream(finalRunParams, {
              onEvent: async (ev) => {
                enqueue(ev);
              },
            });
          } catch (err) {
            if (isAbortError(err)) {
              enqueue({ type: 'error', error: 'Request cancelled.', status: 499 });
            } else {
              const { error, status } = mapInferenceError(err);
              const safe =
                secretsForErr.length > 0
                  ? redactSecrets(error, secretsForErr)
                  : error;
              enqueue({
                type: 'error',
                error: safe,
                ...(status === 426 ? { status } : {}),
              });
            }
          } finally {
            await closeRunners(httpRef, mcpRef, sandboxRef);
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
        async cancel() {
          await closeRunners(httpRef, mcpRef, sandboxRef);
        },
      });

      return new Response(bodyStream, {
        status: 200,
        headers: {
          'Content-Type': AGENT_STREAM_CONTENT_TYPE,
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const { text, toolTrace, cwd, sandboxId, activeSandboxId, usage } =
      await runAgent(finalRunParams);

    if (!text) {
      return Response.json(
        {
          error: 'Empty model response.',
          // Fold-before-persist (fail/cancel): the 502 after resolve still carries
          // the sticky set so the host never wipes a skill attached this turn.
          ...(skills?.attachedSkills ? { attachedSkills: skills.attachedSkills } : {}),
        },
        { status: 502 },
      );
    }

    return Response.json({
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
      ...(cwd != null ? { cwd } : {}),
      ...(sandboxId != null ? { sandboxId } : {}),
      ...(activeSandboxId != null ? { activeSandboxId } : {}),
      // Phase 3 (plan #539 / #327): bounded provider-usage summary captured at
      // completion; absent when the provider reported no usable token counts.
      ...(usage ? { usage } : {}),
      ...(skills?.events?.length ? { skillEvents: skills.events } : {}),
      ...(skills?.attachedSkills ? { attachedSkills: skills.attachedSkills } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return Response.json(
        {
          error: 'Request cancelled.',
          // Phase 2 (#517 / review residual): a 499 abort after resolve must still
          // carry the sticky set so the host folds it before persisting — never a
          // host PUT that wipes a skill attached this turn (fold-before-persist
          // incl. fail/cancel). For the stream path the `skill_attached` events
          // already folded it; this guards the JSON (non-stream) abort path.
          ...(skills?.attachedSkills ? { attachedSkills: skills.attachedSkills } : {}),
        },
        { status: 499 },
      );
    }
    const { status, error, code } = mapInferenceError(err);
    const safe =
      redactList.length > 0 ? redactSecrets(error, redactList) : error;
    return Response.json(
      {
        error: safe,
        ...(code != null ? { code } : {}),
        // Phase 2 (#517 / adversarial-review "fold before persist incl.
        // fail/cancel"): even a FAILED model turn carries the session's current
        // sticky set, so the host folds it before persisting and a host PUT never
        // wipes a skill that was attached this turn before the model errored.
        ...(skills?.attachedSkills ? { attachedSkills: skills.attachedSkills } : {}),
      },
      { status },
    );
  } finally {
    if (!runnersOwnedByStream) {
      await closeRunners(httpRunner, mcpClose, sandboxClient);
    }
  }
}
