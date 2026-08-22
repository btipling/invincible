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
 *   VERCEL_TOKEN          — long-lived Vercel bearer (existing repo secret)
 *   VERCEL_PROJECT_ID     — Vercel project id (existing repo secret)
 *   VERCEL_TEAM_ID        — Vercel team id (existing repo secret)
 *   SMOKE_ENV             — 'production' | 'preview'
 *   WORKFLOWS_SMOKE_POLL_TIMEOUT_MS  — bounded poll budget (default 120000)
 *   WORKFLOWS_SMOKE_POLL_INTERVAL_MS — poll interval (default 2000)
 *
 * World targeting (the review lock): `createWorld()` does NOT read the
 * `WORKFLOW_VERCEL_*` env vars (they are CLI/observability-only) and, without
 * `WORKFLOW_TARGET_WORLD` or `VERCEL_DEPLOYMENT_ID`, resolves to the **local**
 * world on a GHA runner — which would run the 2s fixture locally and exit 0 with
 * Vercel Workflows still OFF (the silent pass this slice forbids). So we inject
 * the SDK's Vercel World explicitly with the existing secrets and hand it to the
 * runtime via `setWorld()`. `start()` requires `workflow.workflowId` (normally
 * stamped by `withWorkflow`'s SWC transform — absent under `tsx`), so we pass the
 * public `{ workflowId }` metadata form matching the deployed fixture's name.
 *
 * Exit 0 ONLY when the fixture run reaches 'completed'. Any other outcome
 * (start throws / run not found / 'failed' / 'cancelled' / still pending at the
 * budget) exits non-zero — fail closed, never a silent pass, never a fallback to
 * the tab-owned /api/agent POST (reintroducing abort-on-unmount, the #710 lie).
 */
import { pathToFileURL } from 'node:url';
import { getRun, start } from 'workflow/api';
import { setWorld } from 'workflow/runtime';
import { createVercelWorld } from '@workflow/world-vercel';

export const FIXTURE_WORKFLOW_ID = 'fixtureWorkflow';

const POLL_TIMEOUT_MS = Number(
  process.env.WORKFLOWS_SMOKE_POLL_TIMEOUT_MS ?? '120000',
);
const POLL_INTERVAL_MS = Number(
  process.env.WORKFLOWS_SMOKE_POLL_INTERVAL_MS ?? '2000',
);
const POLL_JITTER_MS = 500; // ±0.5s jitter — poll an observable run, not a storm.

export type SmokeResult =
  | { code: 0; runId: string }
  | { code: 1; reason: string };

/** Injectable seams so the GHA subject is unit-testable (adversarial Nit L6). */
type SmokeEnv = Record<string, string | undefined>;
export type SmokeDeps = {
  env?: SmokeEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setWorldImpl?: typeof setWorld;
  createVercelWorldImpl?: typeof createVercelWorld;
  startImpl?: typeof start;
  getRunImpl?: typeof getRun;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkEnv(env: SmokeEnv): SmokeResult | null {
  const token = env.VERCEL_TOKEN ?? '';
  const projectId = env.VERCEL_PROJECT_ID ?? '';
  const teamId = env.VERCEL_TEAM_ID ?? '';
  if (!token || !projectId || !teamId) {
    return {
      code: 1,
      reason:
        'workflows-smoke: missing VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID (set repo secrets; fail closed).',
    };
  }
  return null;
}

export async function runSmoke(deps: SmokeDeps = {}): Promise<SmokeResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const doSetWorld = deps.setWorldImpl ?? setWorld;
  const doCreateWorld = deps.createVercelWorldImpl ?? createVercelWorld;
  const doStart = deps.startImpl ?? start;
  const doGetRun = deps.getRunImpl ?? getRun;

  const missing = checkEnv(env);
  if (missing) return missing;

  const token = env.VERCEL_TOKEN ?? '';
  const projectId = env.VERCEL_PROJECT_ID ?? '';
  const teamId = env.VERCEL_TEAM_ID ?? '';
  const targetEnv = env.SMOKE_ENV === 'production' ? 'production' : 'preview';

  // Inject the SDK's Vercel World explicitly (plan-review lock: the GHA talks to
  // api.vercel.com/v1/workflow through the Vercel World). Without this the world
  // resolution would be `local` on a GHA runner and the smoke would silently pass.
  doSetWorld(
    doCreateWorld({
      token,
      projectConfig: { projectId, teamId, environment: targetEnv },
    }),
  );

  // start() reads `workflow.workflowId` (stamped by withWorkflow's SWC transform
  // — absent under `tsx`), so pass the public metadata form explicitly, matching
  // the deployed fixture's function name. `deploymentId: 'latest'` lets the
  // Vercel world resolve the current environment deployment via
  // resolveLatestDeploymentId (it has token+projectId in config) — a GHA runner
  // has no VERCEL_DEPLOYMENT_ID, and getDeploymentId() would throw without this.
  let run;
  try {
    run = await doStart({ workflowId: FIXTURE_WORKFLOW_ID }, [], {
      deploymentId: 'latest',
    });
  } catch (err) {
    return {
      code: 1,
      reason: `workflows-smoke: start() failed (Workflows not enabled/ready on ${targetEnv}?): ${errMsg(err)}`,
    };
  }
  const runId = run.runId;

  console.log(
    `workflows-smoke: started fixture run ${runId} on ${targetEnv}; polling for 'completed' (budget ${POLL_TIMEOUT_MS}ms).`,
  );

  const deadline = now() + POLL_TIMEOUT_MS;
  let lastStatus = 'unknown';
  while (now() < deadline) {
    let runRef;
    try {
      runRef = doGetRun(runId);
    } catch (err) {
      return {
        code: 1,
        reason: `workflows-smoke: getRun() failed (Workflows not ready on ${targetEnv}?): ${errMsg(err)}`,
      };
    }
    try {
      if (!(await runRef.exists)) {
        return {
          code: 1,
          reason: `workflows-smoke: run ${runId} not found — cannot verify completion.`,
        };
      }
      lastStatus = await runRef.status;
    } catch (err) {
      return {
        code: 1,
        reason: `workflows-smoke: getRun() failed (Workflows not ready on ${targetEnv}?): ${errMsg(err)}`,
      };
    }

    if (lastStatus === 'completed') {
      console.log(`workflows-smoke: run ${runId} completed.`);
      return { code: 0, runId };
    }
    if (lastStatus === 'failed' || lastStatus === 'cancelled') {
      return {
        code: 1,
        reason: `workflows-smoke: run ${runId} ended as '${lastStatus}' (not completed).`,
      };
    }

    // Jittered bounded interval: sleep, then loop until the budget caps out.
    const jitter = Math.floor(Math.random() * 2 * POLL_JITTER_MS);
    await sleep(POLL_INTERVAL_MS + jitter);
  }

  return {
    code: 1,
    reason: `workflows-smoke: run ${runId} still '${lastStatus}' after ${POLL_TIMEOUT_MS}ms budget — "run still pending". Re-dispatch once the run settles (plan #785 Risk: pending != pass).`,
  };
}

export async function main(): Promise<void> {
  const res = await runSmoke();
  if (res.code === 0) {
    console.log(`workflows-smoke: run ${res.runId} completed.`);
    process.exit(0);
  }
  console.error(res.reason);
  process.exit(1);
}

// Only drive the CLI when this file is the entry point — never on import (the
// test runner imports `runSmoke`/`SmokeDeps`, and an auto-run would call
// process.exit against the test process).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
