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
 *   WORKFLOWS_SMOKE_POLL_TIMEOUT_MS  — bounded poll budget (default 120000)
 *   WORKFLOWS_SMOKE_POLL_INTERVAL_MS — poll interval (default 2000)
 *
 * World targeting (the review lock): `createWorld()` does NOT read the
 * `WORKFLOW_VERCEL_*` env vars (they are CLI/observability-only) and, without
 * `WORKFLOW_TARGET_WORLD`, resolves to the **local**
 * world on a GHA runner — which would run the 2s fixture locally and exit 0 with
 * Vercel Workflows still OFF (the silent pass this slice forbids). So we inject
 * the SDK's Vercel World explicitly with the existing secrets and hand it to the
 * runtime via `setWorld()`. `start()` requires `workflow.workflowId` (normally
 * stamped by `withWorkflow`'s SWC transform — absent under `tsx`), so we pass the
 * public `{ workflowId }` metadata form.
 *
 * The workflowId MUST be the SDK's namespaced `workflow//{filepath}//{fn}` form
 * the SWC client transform stamps (short "fixtureWorkflow" is NOT in the registry
 * and api.vercel.com lookup would 4xx/fail closed). The exact string is the
 * real SWC output read from a built `.next` (workflow/v1/flow/route.js):
 * `workflow//./lib/workflows/fixtureWorkflow//fixtureWorkflow` — `./` prefix,
 * NO `.ts` extension (getRelativeFilenameForSwc relative path, extension
 * stripped by the transform). A GHA job does not run the Next build (no manifest
 * to read), so the value is pinned to match the deployed fixture's stamp.
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

// SDK-namespaced workflowId matching the deployed fixture's SWC stamp (see the
// header comment). Not the short function name — the Vercel registry keys the
// workflow by `workflow//{filepath}//{fn}`.
export const FIXTURE_WORKFLOW_ID = 'workflow//./lib/workflows/fixtureWorkflow//fixtureWorkflow';

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
  resolveDeploymentIdImpl?: typeof resolveLatestProductionDeploymentId;
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

/**
 * Resolve the latest READY Production deployment id from the Vercel API using
 * the EXISTING repo secrets (VERCEL_TOKEN / VERCEL_PROJECT_ID / VERCEL_TEAM_ID).
 *
 * The SDK's Vercel world derives the run's deployment from
 * `VERCEL_DEPLOYMENT_ID` — a Vercel-runtime-only env var read unconditionally
 * by `world.getDeploymentId()` and again by `resolveLatestDeploymentId` for
 * `'latest'`. A GHA runner has neither, and there is NO deployment-id secret
 * to configure. So we self-resolve: `start()` still needs a concrete
 * production deployment to route its queue message to, but the id is fetched
 * from production itself via the Vercel API — the operator sets nothing new and
 * no `VERCEL_DEPLOYMENT_ID` is required anywhere.
 */
export async function resolveLatestProductionDeploymentId(opts: {
  token: string;
  projectId: string;
  teamId: string;
  environment: string;
}): Promise<string> {
  const url = new URL('https://api.vercel.com/v6/deployments');
  url.searchParams.set('projectId', opts.projectId);
  url.searchParams.set('limit', '1');
  url.searchParams.set('target', opts.environment);
  url.searchParams.set('state', 'READY');
  if (opts.teamId) url.searchParams.set('teamId', opts.teamId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  if (!res.ok) {
    throw new Error(`list production deployments failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    deployments?: Array<{ uid?: string; id?: string }>;
  };
  const dep = body?.deployments?.[0];
  const deploymentId = dep?.uid ?? dep?.id;
  if (!deploymentId) {
    throw new Error('no READY production deployment found for this project');
  }
  return deploymentId;
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
  // Smoke ALWAYS targets Vercel Production — we do not use or build a preview
  // environment, so there is no preview branch (removed with the dispatch input).
  const targetEnv = 'production';

  // The SDK's Vercel world derives the run's deployment from
  // `VERCEL_DEPLOYMENT_ID` (read unconditionally by `world.getDeploymentId()`,
  // and again by `resolveLatestDeploymentId` for `'latest'`). A GHA runner has
  // none and there is NO deployment-id secret to configure — so resolve the
  // latest READY production deployment from the Vercel API itself via the
  // existing VERCEL_TOKEN. The operator sets nothing new.
  const doResolve =
    deps.resolveDeploymentIdImpl ?? resolveLatestProductionDeploymentId;
  let deploymentId: string;
  try {
    deploymentId = await doResolve({
      token,
      projectId,
      teamId,
      environment: targetEnv,
    });
  } catch (err) {
    return {
      code: 1,
      reason: `workflows-smoke: could not resolve the latest production deployment: ${errMsg(err)}`,
    };
  }

  // Inject the SDK's Vercel World explicitly (plan-review lock: the GHA talks to
  // api.vercel.com/v1/workflow through the Vercel World). Without this the world
  // resolution would be `local` on a GHA runner and the smoke would silently pass.
  const world = doCreateWorld({
    token,
    projectConfig: { projectId, teamId, environment: targetEnv },
  });
  // Pin the world's deployment getter to the resolved id so the SDK's
  // unconditional `world.getDeploymentId()` and its queue routing use that id —
  // no `VERCEL_DEPLOYMENT_ID` env var anywhere.
  world.getDeploymentId = async () => deploymentId;
  doSetWorld(world);

  // start() reads `workflow.workflowId` (stamped by withWorkflow's SWC transform
  // — absent under `tsx`), so pass the public metadata form explicitly, matching
  // the deployed fixture's function name. We pass the resolved deployment id
  // EXPLICITLY (never `'latest'`): `'latest'` would round-trip through the
  // world's resolveLatestDeploymentId, which re-reads `VERCEL_DEPLOYMENT_ID`
  // and throws on a runner.
  let run;
  try {
    run = await doStart(
      { workflowId: FIXTURE_WORKFLOW_ID },
      [],
      { deploymentId },
    );
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
