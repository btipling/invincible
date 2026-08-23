import { start } from 'workflow/api';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { turnsFixtureWorkflow } from '../../../lib/workflows/turnsFixtureWorkflow';
import { AGENT_STREAM_CONTENT_TYPE, wantsAgentStream } from '../../../lib/agent/agentStream';

export const runtime = 'nodejs';
// Workflow STEP duration is the Vercel Function ceiling — never the 300 s
// default (parent #764 residual "Step vs 1800s"). Matches the slice-D smoke
// route + `app/api/agent/route.ts` (plan #787 caps table).
export const maxDuration = 1800;

/**
 * backend-agents B spike (plan #787), POST /api/turns — the preview/spike-only
 * probe that starts the turns fixture and hands the client a reconnect cursor.
 *
 * NOT the production turn owner: this ships on a throwaway `/api/turns` prefix
 * and never touches `/api/agent`. The fixture streams the CURRENT
 * AgentStreamEvents so the wiring a real E workflow will emit is validated
 * without any cutover (plan #787 goals 1/2/5).
 *
 * Fail closed (plan-goal 4 / #710 lie): a Workflows-disabled `start` → 503,
 * NEVER a silent fallback to the tab-owned `/api/agent` POST.
 */
function failClosed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Vercel Workflows turns spike failed (fail closed): ${msg}`;
}

/** POST /api/turns → start the turns fixture → x-workflow-run-id + { runId }. */
export async function POST(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  if (!sessionGate.user?.id) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }
  try {
    const run = await start(turnsFixtureWorkflow, []);
    const headers: Record<string, string> = {
      'x-workflow-run-id': run.runId,
    };
    // Client asked for a stream → pipe the run's readable as SSE (same event
    // contract the host already consumes); otherwise JSON { runId }.
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
    return Response.json({ error: failClosed(err) }, { status: 503 });
  }
}
