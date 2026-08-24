/**
 * backend-agents C14b (#835) — `POST /api/turns`: the durable-turn START surface.
 *
 * Starts a Workflows `turnWorkflow` (B12 loop) run for one prompt and streams
 * its live SSE (or returns its `runId`), with the two step seams wired INSIDE
 * the boundary BEFORE `start()` so the B12/B13 steps fail closed if unwired:
 *
 *  1. Persist seam — `setPersistSeamResolver(() => createPersistStepSeam(scope))`
 *     (B13 real B7/B8/B6 Blob + envelope terminal persist → `turnStatus='completed'`),
 *     `scope = { tenantId, userId, sessionId }`.
 *  2. Tool world — `setToolWorldResolver(… buildToolWorld(scope) …)` (C14a:
 *     registry + secrets + signal).
 *  3. Request-scoped model/BYOK resolution feeding `modelGenerateStep`'s
 *     serializable `modelId` (mirrors the `/api/agent` DI root).
 *
 * `turnRunId` is DERIVED in-workflow (`getWorkflowMetadata().workflowRunId`), so
 * the terminal persist's `turnRunId` equals the route-side `run.runId` (never
 * session id). C14b wires the seams + start/stream; the separate post-start
 * `running` PATCH is C14d (out of scope — not built here).
 *
 * Fail closed: `start` throw → 503, never a `/api/agent` fallback (source lock).
 * `maxDuration = 1800` reuses the `/api/agent` constant verbatim (no cap change).
 */
import { start } from 'workflow/api';
import { parseAgentBody } from '../../../lib/agent/agentBody';
import {
  AGENT_STREAM_CONTENT_TYPE,
  wantsAgentStream,
} from '../../../lib/agent/agentStream';
import { buildToolWorld } from '../../../lib/agent/buildToolWorld';
import { mapByokResolveFailure } from '../../../lib/chatServer';
import { createProdServices } from '../../../lib/di';
import { buildUserMcpTools } from '../../../lib/mcp/client';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { resolveSessionStore } from '../../../lib/tenancy/harnessSessionsRedis';
import { setPersistSeamResolver } from '../../../lib/workflows/persistStep';
import { setToolWorldResolver } from '../../../lib/workflows/toolExecuteStep';
import { turnWorkflow } from '../../../lib/workflows/turnWorkflow';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m) — same constant as
// app/api/agent/route.ts, reused verbatim (no cap change).
export const maxDuration = 1800;

/** Composition root — all wiring constructed here, never in route body. */
const services = createProdServices();

function failClosed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Unable to start durable turn (fail closed): ${msg}`;
}

/**
 * POST /api/turns — start one durable turn and stream/return its runId.
 *
 * Body { prompt: string, sessionId: string, modelId?: string }.
 * - `sessionId` REQUIRED → 400 (parseAgentBody treats it optional, but the
 *   persist seam needs a session scope to locate the envelope).
 * - SSE (`Accept: text/event-stream`) → pipe `run.getReadable()` + header.
 * - else → JSON `{ runId }` + `x-workflow-run-id` header.
 * - `start` throw → 503 fail-closed, no `/api/agent` fallback.
 */
export async function POST(req: Request): Promise<Response> {
  // Auth gate FIRST (mirrors app/api/agent/route.ts POST gate) — before any
  // persist wire / start.
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      {
        error:
          'Invalid JSON body. Expected { sessionId: string, prompt: string, modelId?: string }.',
      },
      { status: 400 },
    );
  }

  const parsed = parseAgentBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }
  // parseAgentBody treats `sessionId` as optional → an explicit 400 guard: the
  // persist seam requires a session scope (plan lock).
  if (parsed.sessionId === undefined) {
    return Response.json(
      { error: 'sessionId is required for durable turns.' },
      { status: 400 },
    );
  }
  const sessionId = parsed.sessionId;

  try {
    // Session scope for the persist seam + tool world (tenant resolved server-side).
    const tenantRes =
      await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
    if (!tenantRes.ok) {
      return Response.json(
        { error: 'Unable to resolve tenant for the durable turn.' },
        { status: 503 },
      );
    }
    const scope = { tenantId: tenantRes.value, userId, sessionId };

    // 1. BOUNDARY WIRE: persist seam (B13) — installs BEFORE start() so the
    //    terminal persist step never fails closed.
    setPersistSeamResolver(() => services.createPersistStepSeam(scope));

    // 3. Request-scoped model/BYOK resolution → serializable `modelId` for the
    //    model step (mirrors the /api/agent DI root).
    const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
      userId,
      parsed.modelId,
    );
    if (!byok.ok) {
      const { status, error } = mapByokResolveFailure(byok.reason);
      return Response.json({ error }, { status });
    }

    // 2. BOUNDARY WIRE: C14a tool world (registry + secrets + signal). The
    //    in-step resolver (`toolExecuteStep`) is SYNCHRONOUS, so the (async)
    //    world is assembled here at the boundary and the resolver projects the
    //    fields the step needs — resolved in-step, never a serialized step arg.
    const world = await buildToolWorld({
      userId,
      sessionId,
      signal: req.signal,
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
      byokSecretsToRedact: byok.secretsToRedact,
      ghSecrets: [],
      httpAttachName: null,
    });
    setToolWorldResolver(() => ({
      registry: world.registry,
      secrets: world.secrets,
      signal: world.signal,
    }));

    // The single durable loop entry. `turnRunId` is derived in-workflow from
    // getWorkflowMetadata().workflowRunId — never passed as a start() arg.
    const run = await start(turnWorkflow, [
      { userMessage: parsed.prompt, tools: world.registry, modelId: byok.modelId },
    ]);

    const runHeaders: Record<string, string> = {
      'x-workflow-run-id': run.runId,
    };
    if (wantsAgentStream(req)) {
      return new Response(run.getReadable(), {
        status: 200,
        headers: {
          'content-type': AGENT_STREAM_CONTENT_TYPE,
          ...runHeaders,
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    return Response.json({ runId: run.runId }, { headers: runHeaders });
  } catch (err) {
    return Response.json({ error: failClosed(err) }, { status: 503 });
  }
}
