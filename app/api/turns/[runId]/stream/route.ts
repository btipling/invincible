/**
 * backend-agents C16 (#810) — `GET /api/turns/:runId/stream`: attach/reconnect
 * to a durable-turn SSE stream via `bodyForRun` (never call `getReadable()`
 * in this file). Already-`cancelled`/`failed` is synthetic SSE; `running`/
 * `completed` wrap `getReadable({ startIndex })`.
 *
 * `abort ≠ cancel` — client disconnect closes the reader but never cancels the
 * run. `getRun` is status truth. The producer closed `getWritable()` on all
 * terminal paths (B12 lock), so completed-run streams are valid.
 *
 * Read-only: no envelope writes, no cursor persistence (client responsibility
 * via A3 `meta.turnStreamCursor` carrier).
 *
 * Query params:
 *  - `sessionId`: REQUIRED — the session scope for tenancy-bound ownership
 *    verification. Sanitized against `isRedisSafeOpaqueId` (400 on invalid).
 *    The handler reads the session envelope and checks
 *    `meta.turnRunId === runId` before piping the stream. Store unavailable or
 *    read throw → 503 FAIL-CLOSED (never skip the owner check).
 *    Mismatch → 404 (never 403).
 *  - `?startIndex=N`: optional non-negative integer ≤ TURN_STREAM_CURSOR_MAX
 *    (A3 #797), default 0 for full replay. MID resume when N > 0.
 *  - `runId`: URL path param, validated against TURN_RUN_ID_MAX (A1 #795) via
 *    `sanitizeTurnRunId`. A bad URL param → 400 (unlike A1's drop-to-unset for
 *    envelope reads — a bad URL param is a client error, not a poison).
 *
 * Response:
 *  - 200 + SSE stream (content-type: text/event-stream; charset=utf-8)
 *  - 400 for invalid runId/startIndex/sessionId
 *  - 401 for auth failure
 *  - 404 for run not found OR ownership mismatch (tenancy guard)
 *  - 503 fail-closed for tenant resolve / store unavailable / wrap-path throw
 *
 * No `x-workflow-run-warning` header — this route is read-only (no PATCH).
 */
import { getRun } from 'workflow/api';
import { bodyForRun } from '../../../../../lib/agent/pipeRunReadable';
import {
  AGENT_STREAM_CONTENT_TYPE,
} from '../../../../../lib/agent/agentStream';
import { createProdServices } from '../../../../../lib/di';
import {
  isRedisSafeOpaqueId,
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
 * Attach or reconnect to a durable-turn SSE stream via `bodyForRun`.
 * Already-`cancelled`/`failed` is synthetic SSE (no `getReadable()`).
 * `running`/`completed` wrap `getReadable({ startIndex })`. Read-only — no
 * envelope writes.
 *
 * Tenancy-bound: `sessionId` is REQUIRED and sanitized against
 * `isRedisSafeOpaqueId` (400 on invalid). The handler reads the session
 * envelope and verifies `meta.turnRunId === runId` before piping the stream.
 * FAIL-CLOSED on store unavailable or read throw (503) — the tenancy gate is
 * the only owner check; skipping it would restore the r2 IDOR.
 * Mismatch → 404 (never 403).
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

  // Parse and sanitize sessionId — REQUIRED for tenancy-bound ownership
  // verification. Without this, runIds are project-scoped UUIDs that any
  // authed user could attach (IDOR). The handler reads the session envelope
  // and checks meta.turnRunId === cleanRunId before piping the stream.
  //
  // sessionId is sanitized against `isRedisSafeOpaqueId` (^[A-Za-z0-9_-]{1,512}$)
  // BEFORE it reaches `sessionKeyFor` / `readEnvelope`. A non-opaque id is a
  // client error (400). Without this, an attacker-supplied `sessionId=*` would
  // reach `RedisSessionStore.assertValidSessionRecordKey` → throw, which the
  // old fail-open catch would silently skip (r3 Major L2).
  const rawSessionId = new URL(req.url).searchParams.get('sessionId');
  if (!rawSessionId) {
    return Response.json(
      { error: 'sessionId query parameter is required.' },
      { status: 400 },
    );
  }
  if (!isRedisSafeOpaqueId(rawSessionId)) {
    return Response.json(
      { error: 'Invalid sessionId.' },
      { status: 400 },
    );
  }
  const sessionId = rawSessionId; // type-narrowed by isRedisSafeOpaqueId

  // Tenancy check — resolve tenant for the authenticated user, read the
  // session envelope, verify envelope.meta.turnRunId matches the requested
  // runId. FAIL-CLOSED when the envelope store is unavailable (503) or the
  // envelope read throws (503) — the tenancy gate is the ONLY owner check;
  // skipping it restores the r2 IDOR. SECURITY.md: store unavailable → 503,
  // other user → 404 never 403.
  //
  // Only two paths reach the stream: (a) envelope turnRunId matches,
  // (b) envelope absent → 404.
  const tenantRes =
    await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenantRes.ok) {
    return Response.json(
      { error: 'Unable to resolve tenant for stream attach.' },
      { status: 503 },
    );
  }
  const sessionKey = sessionKeyFor(tenantRes.value, userId, sessionId);

  // Resolve the envelope store — fail-closed (503) when the store is
  // unavailable or not an envelope store. Previously fail-open skipped
  // the ownership check entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let envelopeStore: any;
  try {
    const storeRes = await resolveSessionStore();
    if (!storeRes.ok || !isEnvelopeStore(storeRes.value)) {
      return Response.json(
        { error: 'Unable to attach to run stream (store unavailable).' },
        { status: 503 },
      );
    }
    envelopeStore = storeRes.value;
  } catch {
    return Response.json(
      { error: 'Unable to attach to run stream (store unavailable).' },
      { status: 503 },
    );
  }

  // Read the session envelope — fail-closed (503) on read throw, 404 on
  // miss or turnRunId mismatch. Previously fail-open on read throw.
  try {
    const envelope = await envelopeStore.readEnvelope(sessionKey);
    if (!envelope || envelope.meta?.turnRunId !== cleanRunId) {
      return Response.json(
        { error: `Run not found: ${cleanRunId}` },
        { status: 404 },
      );
    }
  } catch {
    return Response.json(
      { error: 'Unable to attach to run stream (store unavailable).' },
      { status: 503 },
    );
  }

  // Attach to the run stream. getRun, exists, and bodyForRun are all
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

    // bodyForRun: already-cancelled/failed → synthetic SSE, never
    // getReadable(). running/completed wrap getReadable({ startIndex }).
    // Client abort closes the reader but NEVER cancels the run — abort ≠
    // cancel (C16). Server cancel is G22 (#816).
    const headers: Record<string, string> = {
      'content-type': AGENT_STREAM_CONTENT_TYPE,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'x-workflow-run-id': cleanRunId,
    };

    return new Response(await bodyForRun(run, { startIndex }), {
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
