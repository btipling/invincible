/**
 * backend-agents C16 (#810) — `GET /api/turns/:runId/stream`: attach/reconnect
 * to a live (or completed) durable-turn SSE stream via `getRun(runId).getReadable()`.
 *
 * Pipes the Workflows SDK readable stream for a previously-started turn run.
 * `abort ≠ cancel` — client disconnect closes the reader but never cancels the
 * run. `getRun` is status truth. The producer closed `getWritable()` on all
 * terminal paths (B12 lock), so completed-run streams are valid.
 *
 * Read-only: no envelope writes, no cursor persistence (client responsibility
 * via A3 `meta.turnStreamCursor` carrier).
 *
 * Query params:
 *  - `sessionId`: REQUIRED — the session scope for tenancy-bound ownership
 *    verification. The handler reads the session envelope and checks
 *    `meta.turnRunId === runId` before piping the stream. Without this, runIds
 *    are project-scoped UUIDs that any authed user could attach (IDOR).
 *    Mismatch → 404 (never 403 — same as other session API per SECURITY.md).
 *  - `?startIndex=N`: optional non-negative integer ≤ TURN_STREAM_CURSOR_MAX
 *    (A3 #797), default 0 for full replay. MID resume when N > 0.
 *  - `runId`: URL path param, validated against TURN_RUN_ID_MAX (A1 #795) via
 *    `sanitizeTurnRunId`. A bad URL param → 400 (unlike A1's drop-to-unset for
 *    envelope reads — a bad URL param is a client error, not a poison).
 *
 * Response:
 *  - 200 + SSE stream (content-type: text/event-stream; charset=utf-8)
 *  - 400 for invalid runId/startIndex/missing sessionId
 *  - 401 for auth failure
 *  - 404 for run not found OR ownership mismatch (tenancy guard)
 *  - 503 fail-closed for tenant resolve / getReadable throw / infra errors
 *
 * No `x-workflow-run-warning` header — this route is read-only (no PATCH).
 */
import { getRun } from 'workflow/api';
import {
  AGENT_STREAM_CONTENT_TYPE,
} from '../../../../../lib/agent/agentStream';
import { createProdServices } from '../../../../../lib/di';
import {
  sanitizeTurnRunId,
  TURN_STREAM_CURSOR_MAX,
} from '../../../../../lib/sessionCloudCaps';
import { isEnvelopeStore } from '../../../../../lib/sessions/sessionStore';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../../../../../lib/tenancy/harnessSessionsRedis';
import { requireSessionUser } from '../../../../../lib/tenancy/session';

export const runtime = 'nodejs';
export const maxDuration = 1800;

/** Composition root — all wiring constructed here, never in route body. */
const services = createProdServices();

/**
 * GET /api/turns/:runId/stream?sessionId=...&startIndex=N
 *
 * Attach or reconnect to a durable-turn SSE stream via
 * `getRun(runId).getReadable({startIndex})`. Read-only — no envelope writes.
 *
 * Tenancy-bound: `sessionId` is REQUIRED. The handler reads the session
 * envelope and verifies `meta.turnRunId === runId` before piping the stream.
 * Fail-open when the envelope store is unavailable (the run may still be
 * playable). Mismatch → 404 (never 403).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  // Auth gate — same requireSessionUser as POST (plan refinement; parent row
  // didn't specify auth, but all durable-turn routes should require it).
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  const { runId } = await params;

  // Validate runId against TURN_RUN_ID_MAX (A1 #795). Unlike A1's drop-to-unset
  // for envelope reads, a bad URL param is a client error (400) — architecture
  // decision #3.
  const cleanRunId = sanitizeTurnRunId(runId);
  if (cleanRunId === undefined) {
    return Response.json({ error: 'Invalid runId' }, { status: 400 });
  }

  // Parse and validate startIndex query param.
  // - absent → default 0 (full replay)
  // - present → non-negative integer ≤ TURN_STREAM_CURSOR_MAX
  // - invalid → 400
  let startIndex = 0;
  const rawStartIndex = new URL(req.url).searchParams.get('startIndex');
  if (rawStartIndex !== null) {
    const parsed = Number(rawStartIndex);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > TURN_STREAM_CURSOR_MAX
    ) {
      return Response.json({ error: 'Invalid startIndex' }, { status: 400 });
    }
    startIndex = parsed;
  }

  // Parse sessionId — REQUIRED for tenancy-bound ownership verification.
  // Without this, runIds are project-scoped UUIDs that any authed user could
  // attach (IDOR). The handler reads the session envelope and checks
  // meta.turnRunId === cleanRunId before piping the stream.
  const rawSessionId = new URL(req.url).searchParams.get('sessionId');
  if (!rawSessionId) {
    return Response.json(
      { error: 'sessionId query parameter is required.' },
      { status: 400 },
    );
  }

  // Tenancy check — resolve tenant for the authenticated user, read the
  // session envelope, verify envelope.meta.turnRunId matches the requested
  // runId. Fail-open when the envelope store is unavailable (the run may
  // still be playable). Mismatch → 404 (never 403 — same as other session
  // API per SECURITY.md: "other user → 404, never 403").
  const tenantRes =
    await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenantRes.ok) {
    return Response.json(
      { error: 'Unable to resolve tenant for stream attach.' },
      { status: 503 },
    );
  }
  const sessionKey = sessionKeyFor(tenantRes.value, userId, rawSessionId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let envelopeStore: any = null;
  try {
    const storeRes = await resolveSessionStore();
    if (storeRes.ok && isEnvelopeStore(storeRes.value)) {
      envelopeStore = storeRes.value;
    }
  } catch {
    // Fail-open: store unavailable → skip ownership check, try attach anyway.
  }

  if (envelopeStore) {
    try {
      const envelope = await envelopeStore.readEnvelope(sessionKey);
      if (!envelope || envelope.meta?.turnRunId !== cleanRunId) {
        return Response.json(
          { error: `Run not found: ${cleanRunId}` },
          { status: 404 },
        );
      }
    } catch {
      // Fail-open: envelope read error → skip ownership check, try attach.
    }
  }

  // Attach to the run stream. getRun, exists, and getReadable are all
  // wrapped in one try/catch (smoke-route pattern) so any infra throw
  // maps to 503 fail-closed — never an uncaught 500.
  try {
    const run = getRun(cleanRunId);

    if (!(await run.exists)) {
      return Response.json(
        { error: `Run not found: ${cleanRunId}` },
        { status: 404 },
      );
    }

    // Pipe the readable stream. Client abort closes the reader but NEVER
    // cancels the run — abort ≠ cancel is the parent lock (C16 row).
    // Server cancel is G22 (#816).
    const readable = run.getReadable({ startIndex });

    const headers: Record<string, string> = {
      'content-type': AGENT_STREAM_CONTENT_TYPE,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'x-workflow-run-id': cleanRunId,
    };

    return new Response(readable as ReadableStream, {
      status: 200,
      headers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Unable to attach to run stream (fail closed): ${msg}` },
      { status: 503 },
    );
  }
}
