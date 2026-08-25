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
 * Route params:
 *  - `runId`: Workflow run id, validated against TURN_RUN_ID_MAX (A1 #795) via
 *    `sanitizeTurnRunId`. A bad URL param → 400 (unlike A1's drop-to-unset for
 *    envelope reads — a bad URL param is a client error, not a poison).
 *  - `?startIndex=N`: optional non-negative integer ≤ TURN_STREAM_CURSOR_MAX
 *    (A3 #797), default 0 for full replay. MID resume when N > 0.
 *
 * Response:
 *  - 200 + SSE stream (content-type: text/event-stream; charset=utf-8)
 *  - 400 for invalid runId/startIndex
 *  - 401 for auth failure
 *  - 404 for run not found (`await run.exists === false`)
 *  - 503 fail-closed for getReadable throw
 *
 * No `x-workflow-run-warning` header — this route is read-only (no PATCH).
 */
import { getRun } from 'workflow/api';
import {
  AGENT_STREAM_CONTENT_TYPE,
} from '../../../../../lib/agent/agentStream';
import {
  sanitizeTurnRunId,
  TURN_STREAM_CURSOR_MAX,
} from '../../../../../lib/sessionCloudCaps';
import { requireSessionUser } from '../../../../../lib/tenancy/session';

export const runtime = 'nodejs';
export const maxDuration = 1800;

/**
 * GET /api/turns/:runId/stream?startIndex=N
 *
 * Attach or reconnect to a durable-turn SSE stream via
 * `getRun(runId).getReadable({startIndex})`. Read-only — no envelope writes.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  // Auth gate — same requireSessionUser as POST (plan refinement; parent row
  // didn't specify auth, but all durable-turn routes should require it).
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;

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

  // Resolve the run handle. getRun(runId): Run is SYNC and does NOT throw for a
  // missing run — it returns a handle. Not-found is `await run.exists === false`
  // (in-repo precedent: `app/api/workflows/smoke/route.ts`).
  const run = getRun(cleanRunId);

  if (!(await run.exists)) {
    return Response.json(
      { error: `Run not found: ${cleanRunId}` },
      { status: 404 },
    );
  }

  // Pipe the readable stream. Client abort closes the reader but NEVER cancels
  // the run — abort ≠ cancel is the parent lock (C16 row). Server cancel is
  // G22 (#816).
  let readable: ReturnType<typeof run.getReadable>;
  try {
    readable = run.getReadable({ startIndex });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Unable to attach to run stream (fail closed): ${msg}` },
      { status: 503 },
    );
  }

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
}
