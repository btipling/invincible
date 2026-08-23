import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_WORKFLOW_ID,
  resolveLatestProductionDeploymentId,
  runSmoke,
  type SmokeDeps,
  type SmokeResult,
} from './workflows-smoke';

/**
 * Unit tests for the GHA subject `scripts/workflows-smoke.ts` (adversarial
 * review PR #786 Major L1+L4 / Nit L6).
 *
 * The adversarial finding: under `tsx` there is NO `withWorkflow` SWC transform,
 * so `start()` receives no `workflow.workflowId` (throws
 * `start-invalid-workflow-function`), and without an injected world the SDK's
 * `createWorld()` falls back to the **local** world on a GHA runner (silent pass
 * with Vercel Workflows OFF). These tests lock the fix: the Vercel world is
 * injected from the existing secrets, `start` is given an explicit `workflowId`,
 * and every poll branch (completed / not-found / failed / cancelled / pending
 * past budget) fails closed.
 *
 * The script is DI-friendly (SmokeDeps), so no `vi.mock` of the SDK is needed —
 * inject the seams directly. Run: `node_modules/vitest/vitest.mjs run
 * scripts/workflows-smoke.test.ts`.
 */

const SECRETS_ENV: Record<string, string> = {
  VERCEL_TOKEN: 'tok_prod',
  VERCEL_PROJECT_ID: 'prj_x',
  VERCEL_TEAM_ID: 'team_y',
};

/** Narrow the SmokeResult union after asserting `res.code === 1`. */
function failureReason(res: SmokeResult): string {
  if (res.code === 1) return res.reason;
  throw new Error('expected a failed smoke result');
}

type StartedRun = { runId: string };
function completedRun(runId = 'wrun_1') {
  return {
    exists: Promise.resolve(true),
    status: Promise.resolve('completed'),
    returnValue: Promise.resolve({ status: 'completed' }),
  };
}

function deps(overrides: Partial<SmokeDeps> = {}): SmokeDeps & {
  startCalls: unknown[][];
  setWorldCalls: unknown[][];
  createWorldCalls: unknown[][];
} {
  const startCalls: unknown[][] = [];
  const setWorldCalls: unknown[][] = [];
  const createWorldCalls: unknown[][] = [];
  let now: () => number = Date.now;
  const base: SmokeDeps & {
    startCalls: unknown[][];
    setWorldCalls: unknown[][];
    createWorldCalls: unknown[][];
  } = {
    env: { ...SECRETS_ENV },
    now: () => now(),
    sleep: async () => {},
    startImpl: (async (workflow: unknown, ..._rest: unknown[]) => {
      startCalls.push([workflow, ..._rest]);
      // Emulate the SDK: without a workflowId (i.e. a bare untransformed
      // function under tsx) `start` fails closed.
      if (typeof workflow === 'object' && workflow !== null && 'workflowId' in workflow) {
        return { runId: 'wrun_1' } as StartedRun;
      }
      throw new Error("'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.");
    }) as unknown as SmokeDeps['startImpl'],
    getRunImpl: (() => completedRun()) as unknown as SmokeDeps['getRunImpl'],
    setWorldImpl: ((world: unknown) => {
      setWorldCalls.push([world]);
    }) as unknown as SmokeDeps['setWorldImpl'],
    createVercelWorldImpl: ((config: unknown) => {
      createWorldCalls.push([config]);
      return { injected: true };
    }) as unknown as SmokeDeps['createVercelWorldImpl'],
    // A GHA runner has no VERCEL_DEPLOYMENT_ID; the smoke self-resolves the
    // latest production deployment from the Vercel API. Inject a fixed stub for
    // the unit subject (the real resolver is exercised separately).
    resolveDeploymentIdImpl: (async () => 'dpl_prod') as unknown as SmokeDeps['resolveDeploymentIdImpl'],
    startCalls,
    setWorldCalls,
    createWorldCalls,
  };
  // Allow overriding `now` fully (the closure above reads the local var).
  return Object.assign(base, overrides, {
    now: overrides.now ?? base.now,
    startCalls,
    setWorldCalls,
    createWorldCalls,
  });
}

describe('scripts/workflows-smoke (GHA smoke subject)', () => {
  it('injects the SDK Vercel world with the secrets-mapped config (no `local` fallback)', async () => {
    const d = deps();
    const res = await runSmoke(d);
    expect(res.code).toBe(0);
    expect(d.createWorldCalls).toHaveLength(1);
    expect(d.createWorldCalls[0][0]).toEqual({
      token: 'tok_prod',
      projectConfig: { projectId: 'prj_x', teamId: 'team_y', environment: 'production' },
    });
    expect(d.setWorldCalls).toHaveLength(1);
    expect((d.setWorldCalls[0][0] as { injected: boolean }).injected).toBe(true);
  });

  it('passes an explicit SDK-namespaced workflowId to start() — never a bare untransformed function', async () => {
    const d = deps();
    const res = await runSmoke(d);
    expect(res.code).toBe(0);
    expect(d.startCalls).toHaveLength(1);
    const workflowArg = d.startCalls[0][0] as { workflowId?: string };
    expect(workflowArg.workflowId).toBe(FIXTURE_WORKFLOW_ID);
    // Adversarial review PR #786 (round 2) Major L1+L6: the value must be the
    // SDK's namespaced `workflow//{filepath}//{fn}` form the SWC transform
    // stamps — the short function name is NOT in the Vercel registry and the
    // api.vercel.com lookup would 4xx/fail closed (gate never proves enablement).
    //
    // Adversarial review PR #786 (round 3) Nit L6 / merge Optional: pin the FULL
    // SDK-stamped string (exact match PLUS the `./`-prefixed fixture middle),
    // not merely the prefix/suffix regex shape — so a dropped `./` or a
    // renamed/relocated fixture file fails here locally instead of staying green
    // and 4xx'ing (fail-closed) only at dispatch. File-move drift stays a local
    // red, not a silent pass or a late dispatch failure.
    expect(FIXTURE_WORKFLOW_ID).toBe('workflow//./lib/workflows/fixtureWorkflow//fixtureWorkflow');
    expect(FIXTURE_WORKFLOW_ID).toMatch(/\/\/\.\/lib\/workflows\/fixtureWorkflow\/\//);
    expect(FIXTURE_WORKFLOW_ID).not.toBe('fixtureWorkflow');
  });

  it('self-resolves the production deployment, pins world.getDeploymentId, and passes it explicitly (never latest)', async () => {
    const d = deps();
    const res = await runSmoke(d);
    expect(res.code).toBe(0);
    // start() receives the resolved production deployment id explicitly, NOT
    // 'latest' (which would round-trip through resolveLatestDeploymentId and
    // re-read the absent VERCEL_DEPLOYMENT_ID).
    const startOpts = d.startCalls[0][2] as { deploymentId?: string };
    expect(startOpts).toBeDefined();
    expect(startOpts.deploymentId).toBe('dpl_prod');
    expect(startOpts.deploymentId).not.toBe('latest');
    // The injected world's getDeploymentId is pinned to the resolved id so the
    // SDK's unconditional read never looks at a VERCEL_DEPLOYMENT_ID env var.
    const world = d.setWorldCalls[0][0] as {
      getDeploymentId: () => Promise<string>;
    };
    await expect(world.getDeploymentId()).resolves.toBe('dpl_prod');
  });

  it('fails closed (code 1) when the production deployment cannot be resolved — never calls start', async () => {
    const d = deps({
      resolveDeploymentIdImpl: (async () => {
        throw new Error('no READY production deployment found');
      }) as unknown as SmokeDeps['resolveDeploymentIdImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/production deployment/);
    expect(d.startCalls).toHaveLength(0);
  });

  it('fails closed (code 1) when start() throws (Workflows disabled / start rejected)', async () => {
    const d = deps({
      startImpl: (async () => {
        throw new Error('Workflow feature is not enabled for this project.');
      }) as unknown as SmokeDeps['startImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/start\(\) failed/);
  });

  it('fails closed (code 1) when project secrets are missing, and never calls start', async () => {
    const d = deps({ env: { VERCEL_TOKEN: 'tok' } });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/missing VERCEL_TOKEN/);
    expect(d.startCalls).toHaveLength(0);
    expect(d.createWorldCalls).toHaveLength(0);
  });

  it('poll → run not found → code 1 (fail closed)', async () => {
    const d = deps({
      getRunImpl: (() => ({
        exists: Promise.resolve(false),
        status: Promise.resolve('unknown'),
        returnValue: Promise.resolve(null),
      })) as unknown as SmokeDeps['getRunImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/not found/);
  });

  it('poll → failed status → code 1 (never a silent pass)', async () => {
    const d = deps({
      getRunImpl: (() => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('failed'),
        returnValue: Promise.resolve(null),
      })) as unknown as SmokeDeps['getRunImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/'failed'/);
  });

  it('poll → cancelled status → code 1 (never a silent pass)', async () => {
    const d = deps({
      getRunImpl: (() => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('cancelled'),
        returnValue: Promise.resolve(null),
      })) as unknown as SmokeDeps['getRunImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/'cancelled'/);
  });

  it('poll → still pending at the poll budget → code 1 ("run still pending")', async () => {
    let t = 1000;
    const d = deps({
      now: () => t,
      // Advance the wall clock past each interval so the bounded poll loop exits.
      sleep: async () => {
        t += 3000;
      },
      getRunImpl: (() => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('queued'),
        returnValue: Promise.resolve(null),
      })) as unknown as SmokeDeps['getRunImpl'],
    });
    const res = await runSmoke(d);
    expect(res.code).toBe(1);
    expect(failureReason(res)).toMatch(/still 'queued'.*pending/);
  });

  it('poll → completed → code 0', async () => {
    const d = deps();
    const res = await runSmoke(d);
    expect(res).toEqual({ code: 0, runId: 'wrun_1' });
  });
});

describe('resolveLatestProductionDeploymentId', () => {
  it('calls /v6/deployments with production filters and returns the latest READY deployment uid', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          deployments: [{ uid: 'dpl_abc', id: 'dpl_abc' }],
          pagination: { count: 1, next: null, prev: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const id = await resolveLatestProductionDeploymentId({
        token: 'tok_prod',
        projectId: 'prj_x',
        teamId: 'team_y',
        environment: 'production',
      });
      expect(id).toBe('dpl_abc');
      expect(seen).toHaveLength(1);
      const url = new URL(seen[0].url);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://api.vercel.com/v6/deployments',
      );
      expect(url.searchParams.get('projectId')).toBe('prj_x');
      expect(url.searchParams.get('teamId')).toBe('team_y');
      expect(url.searchParams.get('target')).toBe('production');
      expect(url.searchParams.get('state')).toBe('READY');
      expect(url.searchParams.get('limit')).toBe('1');
      expect(seen[0].init.headers).toEqual({
        Authorization: 'Bearer tok_prod',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    try {
      await expect(
        resolveLatestProductionDeploymentId({
          token: 't',
          projectId: 'p',
          teamId: 'c',
          environment: 'production',
        }),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when no READY production deployment is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
      ),
    );
    try {
      await expect(
        resolveLatestProductionDeploymentId({
          token: 't',
          projectId: 'p',
          teamId: 'c',
          environment: 'production',
        }),
      ).rejects.toThrow(/no READY production deployment/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
