/**
 * Standalone Vercel Workflows smoke (backend-agents D, plan #785 — review lock).
 *
 * Drives the Vercel Workflows API through the Workflow SDK's Vercel World using
 * the EXISTING repo secrets (VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID),
 * already dual-stored for the sandbox — NO new secret. A server-side GHA job
 * cannot present a browser session cookie, so this does NOT call the authed
 * /api/workflows/smoke route (that route stays the human/dashboard surface).
 *
 * Env (set by .github/workflows/workflows-smoke.yml; values never echoed):
 *   VERCEL_TOKEN        — long-lived Vercel bearer (existing repo secret)
 *   VERCEL_PROJECT_ID   — Vercel project id (existing repo secret)
 *   VERCEL_TEAM_ID      — Vercel team id (existing repo secret)
 *   SMOKE_ENV           — 'production' | 'preview'
 *   WORKFLOWS_SMOKE_POLL_TIMEOUT_MS  — bounded poll budget (default 120000)
 *   WORKFLOWS_SMOKE_POLL_INTERVAL_MS — poll interval (default 2000)
 *
 * Exit 0 ONLY when the fixture run reaches 'completed'. Any other outcome
 * (start throws / run not found / 'failed' / still pending at the budget) exits
 * non-zero — fail closed, never a silent pass, never a fallback to the
 * tab-owned /api/agent POST (reintroducing abort-on-unmount, the #710 lie).
 */
import { start, getRun } from 'workflow/api';
import { fixtureWorkflow } from '../lib/workflows/fixtureWorkflow';

const POLL_TIMEOUT_MS = Number(process.env.WORKFLOWS_SMOKE_POLL_TIMEOUT_MS ?? '120000');
const POLL_INTERVAL_MS = Number(process.env.WORKFLOWS_SMOKE_POLL_INTERVAL_MS ?? '2000');
const POLL_JITTER_MS = 500; // ±0.5s jitter — poll an observable run, not a storm.

const token = process.env.VERCEL_TOKEN ?? '';
const projectId = process.env.VERCEL_PROJECT_ID ?? '';
const teamId = process.env.VERCEL_TEAM_ID ?? '';
const env = process.env.SMOKE_ENV === 'production' ? 'production' : 'preview';

// Map the existing secrets onto the SDK's Vercel World config surface (the CLI
// uses the same --project/--team/--authToken/--env shape, grounded in
// workflow-sdk.dev/worlds/vercel). The SDK's api.vercel.com/v1/workflow backend
// is what the review-locked "REST API directly" resolves to.
if (!token || !projectId || !teamId) {
  console.error(
    'workflows-smoke: missing VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID (set repo secrets; fail closed).',
  );
  process.exit(1);
}
process.env.WORKFLOW_VERCEL_AUTH_TOKEN = token;
process.env.WORKFLOW_VERCEL_PROJECT = projectId;
process.env.WORKFLOW_VERCEL_TEAM = teamId;
process.env.WORKFLOW_VERCEL_ENV = env;

function failClosed(msg: string): never {
  console.error(`workflows-smoke: ${msg}`);
  process.exit(1);
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let runId: string;
  try {
    const run = await start(fixtureWorkflow, [], { deploymentId: 'latest' });
    runId = run.runId;
  } catch (err) {
    failClosed(
      `start() failed (Workflows not enabled/ready on ${env}?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  console.log(
    `workflows-smoke: started fixture run ${runId} on ${env}; polling for 'completed' (budget ${POLL_TIMEOUT_MS}ms).`,
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    try {
      const run = getRun(runId);
      if (!(await run.exists)) {
        failClosed(`run ${runId} not found — cannot verify completion.`);
      }
      lastStatus = await run.status;
    } catch (err) {
      failClosed(
        `getRun() failed (Workflows not ready on ${env}?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (lastStatus === 'completed') {
      console.log(`workflows-smoke: run ${runId} completed.`);
      process.exit(0);
    }
    if (lastStatus === 'failed' || lastStatus === 'cancelled') {
      failClosed(`run ${runId} ended as '${lastStatus}' (not completed).`);
    }

    // Jittered bounded interval: sleep, then loop until the budget caps out.
    const jitter = Math.floor(Math.random() * 2 * POLL_JITTER_MS);
    await sleepMs(POLL_INTERVAL_MS + jitter);
  }

  failClosed(
    `run ${runId} still '${lastStatus}' after ${POLL_TIMEOUT_MS}ms budget — "run still pending". Re-dispatch once the run settles (plan #785 Risk: pending != pass).`,
  );
}

void main();
