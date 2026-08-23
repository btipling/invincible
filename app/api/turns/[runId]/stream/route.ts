import { getRun } from 'workflow/api';
import { requireSessionUser } from '../../../../../lib/tenancy/session';
import { AGENT_STREAM_CONTENT_TYPE } from '../../../../../lib/agent/agentStream';

export const runtime = 'nodejs';
export const maxDuration = 1800;

/**
 * backend-agents B spike (plan #787), GET /api/turns/:runId/stream — the
 * RECONNECT primitive: replay the fixture's AgentStreamEvent stream from an
 * arbitrary `startIndex` (the resume cursor for viewport attach, slice F).
 *
 * `startIndex` is optional; default 0 (full history). The spike only uses
 * non-negative 0/mid indices — negative (tail-relative) readings are the empty
 * SDK contract and out of scope for this probe (plan #787 caps table). Fail
 * closed: unknown run → 404, Workflows-disabled `getRun` throw → 503, never a
 * tab-owned `/api/agent` fallback.
 */
function failClosed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Vercel Workflows turns spike failed (fail closed): ${msg}`;
}

/** GET /api/turns/:runId/stream?startIndex=N → resume the run's SSE stream. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  if (!sessionGate.user?.id) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }
  const { runId } = await params;
  if (!runId) {
    return Response.json({ error: 'Missing runId path parameter.' }, { status: 400 });
  }
  // Non-negative, integer startIndex; default 0 (full history). Non-numeric /
  // negative / overflow clamps to 0 (head) — the spike's only realistic values.
  const raw = new URL(req.url).searchParams.get('startIndex');
  let startIndex = 0;
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) startIndex = n;
  }
  try {
    const run = getRun(runId);
    if (!(await run.exists)) {
      return Response.json({ error: 'Workflow run not found.' }, { status: 404 });
    }
    const stream = run.getReadable({ startIndex });
    return new Response(stream, {
      headers: {
        'Content-Type': AGENT_STREAM_CONTENT_TYPE,
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    return Response.json({ error: failClosed(err) }, { status: 503 });
  }
}
