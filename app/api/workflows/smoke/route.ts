import { getRun, start } from 'workflow/api';
import { requireSessionUser } from '../../../../lib/tenancy/session';
import { fixtureWorkflow } from '../../../../lib/workflows/fixtureWorkflow';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m) — Workflow step
// duration is the Function ceiling, never the 300 s default (plan #785 goal 3).
export const maxDuration = 1800;

/**
 * Human/dashboard smoke surface for backend-agents D (plan #785): proves
 * `start` → `getRun` → `completed` against the deployed, Workflows-enabled
 * project.
 *
 * NOT the GHA automation path: `requireSessionUser()` is next-auth cookie-gated
 * and a server-side GHA job has no browser cookie, so `workflows-smoke.yml`
 * talks to the Vercel Workflows API directly (the SDK's Vercel World) with the
 * existing repo secrets. This route stays the authed, dashboard-reachable
 * surface (plan-review lock).
 *
 * Fail closed (plan #785 goal 6): a Workflows-disabled `start`/`getRun` maps to
 * 503 with a clear error — NEVER a silent fallback to the tab-owned `/api/agent`
 * POST (reintroducing abort-on-unmount, the #710 lie).
 */

function failClosed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Vercel Workflows smoke failed (fail closed): ${msg}`;
}

// Bounded per-process minimum interval between POST starts (adversarial review
// PR #786 Minor L5+L2: any signed-in tenant member could otherwise hammer this
// route and burn the project's SHARED Workflows quota). ONE start per window.
// This is intentionally defense-in-depth at the human/dashboard surface, not a
// global limiter.
//
// ADMITTED RESIDUAL (PR #786 round 2 Minor L5, explicitly deferred): cold starts
// and N concurrent isolates each hold their own `lastStartAtMs = 0`, so parallel
// POSTs across isolates/starts are not serialized — the hammer vector is not
// fully closed. A real cross-isolate limiter needs shared KV/Upstash state,
// which is NEW infra surface this lightweight dashboard probe intentionally does
// not ship; the adversarial merge guidance marks it not-merge-blocking. The
// fixture is a 2s no-op and the human/dashboard route is the only caller, so the
// practical quota cost of a burst is bounded.
// NEW smoke cap (plan #785 Caps table style): WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS = 15000.
const WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS = 15_000;
let lastStartAtMs = 0;

/** POST /api/workflows/smoke → start the fixture, return { runId }. */
export async function POST(_req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  if (!sessionGate.user?.id) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }
  const now = Date.now();
  if (now - lastStartAtMs < WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS) {
    return Response.json(
      {
        error: `Workflows smoke rate limit: wait a moment before starting another run (min ${WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS}ms).`,
      },
      { status: 429 },
    );
  }
  lastStartAtMs = now;
  try {
    const run = await start(fixtureWorkflow, []);
    return Response.json({ runId: run.runId });
  } catch (err) {
    return Response.json({ error: failClosed(err) }, { status: 503 });
  }
}

/** GET /api/workflows/smoke?runId=… → poll one run → { status, value? }. */
export async function GET(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  if (!sessionGate.user?.id) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }
  const runId = new URL(req.url).searchParams.get('runId');
  if (!runId) {
    return Response.json(
      { error: 'Missing runId query parameter.' },
      { status: 400 },
    );
  }
  try {
    const run = getRun(runId);
    if (!(await run.exists)) {
      return Response.json({ error: 'Workflow run not found.' }, { status: 404 });
    }
    const status = await run.status;
    const body: Record<string, unknown> = { status };
    if (status === 'completed') {
      body.value = await run.returnValue;
    }
    return Response.json(body);
  } catch (err) {
    return Response.json({ error: failClosed(err) }, { status: 503 });
  }
}
