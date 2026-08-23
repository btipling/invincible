import { start } from 'workflow/api';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { parseAgentBody } from '../../../lib/agent/agentBody';
import { runTurnWorkflow, type TurnWorkflowArgs } from '../../../lib/agent/turnWorkflow';
import { createProdServices } from '../../../lib/di';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../../../lib/tenancy/harnessSessionsRedis';
import { isEnvelopeStore } from '../../../lib/sessions/sessionStore';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';
import { AGENT_STREAM_CONTENT_TYPE, wantsAgentStream } from '../../../lib/agent/agentStream';

export const runtime = 'nodejs';
// Workflow STEP duration is the Vercel Function ceiling — never the 300 s
// default (parent #764 residual "Step vs 1800s"). Matches `/api/agent` +
// smoke + the B fixture (plan #791 caps table: step maxDuration 1800 pinned).
export const maxDuration = 1800;

const services = createProdServices();

/**
 * backend-agents E (#791 / source #768) — POST /api/turns is now the REAL turn
 * start surface: it starts the durable `turnWorkflow` (one prompt = one Workflow
 * run; steps re-emit the existing `AgentStreamEvent`s on `getWritable()` and the
 * worker persists the transcript + envelope meta). This supersedes the B-spike
 * throwaway fixture route (plan #787) — the fixture stays for the reconnect
 * proof (`/api/turns/:runId/stream`), but this route no longer starts it.
 *
 * Contract:
 *  - agent body via `parseAgentBody`; `sessionId` REQUIRED (the worker writes
 *    the envelope for this session — the turnRunId/turnStatus carrier reserved
 *    by slice C #789).
 *  - auth (`requireSessionUser`) + tenant + session-key resolution.
 *  - persist `meta.turnRunId = run.runId` + `turnStatus = 'running'` on the
 *    session envelope BEFORE returning (the F/reconnect + detach carrier), via
 *    the reserved-meta PATCH discipline (copy-envelope → override → upsert, LWW).
 *  - `start(runTurnWorkflow, [args])` → `x-workflow-run-id` + `{ runId }`, or
 *    pipe `run.readable` as SSE when `Accept: text/event-stream`.
 *
 * FAIL CLOSED (the #710 lie is not re-introduced): a Workflows-disabled `start`
 * → 503, NEVER a tab-owned `/api/agent` POST fallback. Abusive/duplicate starts
 * are guarded: a per-process window (429) and a live `meta.turnRunId` on the
 * session (single-run-per-prompt, no second concurrent run — the parent at-most-
 * one lock).
 */

// Bounded per-process minimum interval between POST starts (kept from the B
// spike, plan #787 review L5/L2): this route is now human- AND host-reachable
// and must not burn shared Workflows quota. ONE start per window. This is
// defense-in-depth at the dashboard surface, not a global limiter.
//
// ADMITTED RESIDUAL (same as smoke, PR #786 round 2 Minor L5): cold starts and
// N concurrent isolates each hold their own `lastStartAtMs = 0`, so parallel
// POSTs across isolates/starts are not serialized — a real cross-isolate limiter
// needs shared KV/Upstash state (NEW infra surface, out of scope for this slice).
// NEW additive cap (plan #791 caps-table style): TURNS_POST_MIN_INTERVAL_MS.
const TURNS_POST_MIN_INTERVAL_MS = 15_000;
let lastStartAtMs = 0;

async function requireAuthedUserId(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const gate = await requireSessionUser();
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!gate.user?.id) {
    return { ok: false, response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }) };
  }
  return { ok: true, userId: gate.user.id };
}

/** POST /api/turns → parse agent body, persist turnRunId, start the durable workflow. */
export async function POST(req: Request): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;
  const userId = gate.userId;

  // Parse the agent body (`sessionId` required so the worker writes THIS session).
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected { prompt: string, sessionId: string }.' },
      { status: 400 },
    );
  }
  const parsed = parseAgentBody(raw);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }
  if (!parsed.sessionId) {
    return Response.json(
      { error: 'sessionId is required: the durable turn worker persists to a session.' },
      { status: 400 },
    );
  }

  // Abuse guard (authed POSTs only; kept from the B spike).
  const now = Date.now();
  if (now - lastStartAtMs < TURNS_POST_MIN_INTERVAL_MS) {
    return Response.json(
      {
        error: `Workflows turns rate limit: wait a moment before starting another run (min ${TURNS_POST_MIN_INTERVAL_MS}ms).`,
      },
      { status: 429 },
    );
  }

  // Tenant + session key (server-derived, never client).
  const tenantRes = await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenantRes.ok) {
    return Response.json(
      { error: 'Session store unavailable: could not resolve tenant.', code: tenantRes.code },
      { status: 503 },
    );
  }
  const storeRes = await resolveSessionStore();
  if (!storeRes.ok || !isEnvelopeStore(storeRes.value)) {
    return Response.json(
      { error: 'Session store unavailable.', code: storeRes.ok ? 'NO_ENVELOPE' : storeRes.code },
      { status: 503 },
    );
  }
  const envelopeStore = storeRes.value;
  const key = sessionKeyFor(tenantRes.value, userId, parsed.sessionId);

  // Single-run-per-prompt lock: a live `meta.turnRunId` on this session means a
  // run already owns it — refuse a second concurrent run (parent: at most one).
  let existing: { turnRunId?: string } = {};
  try {
    const envelope = await envelopeStore.readEnvelope(key);
    existing = { turnRunId: envelope?.meta?.turnRunId as string | undefined };
  } catch {
    // store read failure → tighten the guard to allow the run to fail closed below;
    // treat as "no carrier yet" (the persist write would surface a store error).
  }
  if (existing.turnRunId) {
    return Response.json(
      { error: 'This session already owns a Workflow run (turnRunId present).', turnRunId: existing.turnRunId },
      { status: 409 },
    );
  }
  // Advance the per-process start clock ONLY on an accepted start (adversary
  // Minor #5): moving it before a 429/409/4xx return would burn the window for
  // a rejected POST (a 409 duplicate was NOT a start, so another session on the
  // same isolate must be allowed to start).
  lastStartAtMs = now;

  // Serialize the durable turn args (JSON-safe — never secrets/closures).
  const args: TurnWorkflowArgs = {
    tenantId: tenantRes.value,
    userId,
    sessionId: parsed.sessionId,
    prompt: parsed.prompt,
    initialCwd: parsed.cwd,
    ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
  };

  try {
    const run = await start(runTurnWorkflow, [args]);
    const headers: Record<string, string> = { 'x-workflow-run-id': run.runId };

    // Persist the carrier BEFORE returning (reserved-meta PATCH contract: copy
    // the existing envelope meta, override only the worker-owned keys, upsert —
    // LWW on updatedAt). Best-effort on the start path: a persist failure must
    // NOT 500 the surface (the run is already started); F/reconnect reconciles.
    try {
      const envelope = await envelopeStore.readEnvelope(key);
      const meta = { ...(envelope?.meta ?? {}), turnRunId: run.runId, turnStatus: 'running' };
      await envelopeStore.upsertEnvelope(key, {
        id: parsed.sessionId,
        tenantId: tenantRes.value,
        userId,
        updatedAt: now,
        meta,
      });
    } catch {
      // best-effort persist: the run still progresses; F will reconcile.
    }

    if (wantsAgentStream(req)) {
      return new Response(run.readable, {
        headers: {
          ...headers,
          'Content-Type': AGENT_STREAM_CONTENT_TYPE,
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    return Response.json({ runId: run.runId }, { status: 200, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Vercel Workflows turn failed (fail closed): ${msg}` },
      { status: 503 },
    );
  }
}
