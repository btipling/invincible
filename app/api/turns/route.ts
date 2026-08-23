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

// Bounded per-process minimum interval between POST starts (adversarial review
// PR #788 Major L5+L2: this route is a second human-reachable start() and must
// not drop the abuse control the sibling slice-D smoke route gained from review
// — WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS = 15000 → 429). ONE start per window.
// This is intentionally defense-in-depth at the dashboard surface, not a global
// limiter.
//
// ADMITTED RESIDUAL (same as smoke, PR #786 round 2 Minor L5, explicitly
// deferred there): cold starts and N concurrent isolates each hold their own
// `lastStartAtMs = 0`, so parallel POSTs across isolates/starts are not
// serialized — a real cross-isolate limiter needs shared KV/Upstash state
// (NEW infra surface a throwaway spike probe intentionally does not ship). The
// fixture is 6 writes + close and the route is the only caller, so the practical
// quota cost of a burst is bounded.
// NEW spike cap (plan #787 Caps table style): TURNS_POST_MIN_INTERVAL_MS = 15000.
const TURNS_POST_MIN_INTERVAL_MS = 15_000;
let lastStartAtMs = 0;

/** POST /api/turns → start the turns fixture → x-workflow-run-id + { runId }. */
export async function POST(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  if (!sessionGate.user?.id) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }
  const now = Date.now();
  if (now - lastStartAtMs < TURNS_POST_MIN_INTERVAL_MS) {
    return Response.json(
      {
        error: `Workflows turns spike rate limit: wait a moment before starting another run (min ${TURNS_POST_MIN_INTERVAL_MS}ms).`,
      },
      { status: 429 },
    );
  }
  lastStartAtMs = now;
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
