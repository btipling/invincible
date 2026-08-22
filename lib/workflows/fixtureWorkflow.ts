import { sleep } from 'workflow';

/**
 * Trivial Vercel-Workflows smoke fixture (backend-agents D, plan #785).
 *
 * A `"use workflow"` orchestrator that does a short durable pause and returns a
 * run marker. It proves `start` → `getRun` → `completed` against a deployed,
 * Workflows-enabled Vercel project and makes the run + its sleeping step
 * observable in Vercel → Observability → Workflows before E (#768) ports a real
 * prompt into a workflow.
 *
 * Pure server-side (Vercel backend layer) — never imported by Wasm/DOM. The
 * step ceiling is the Function ceiling (the smoke route pins maxDuration=1800),
 * never the 300 s default (plan #785 goal 3: "no silent 300 s default drop").
 */
export async function fixtureWorkflow(): Promise<{ status: 'completed' }> {
  'use workflow';

  // Durable pause — consumes no compute; visible in the dashboard as a sleeping
  // step before the run completes.
  await sleep('2s');

  return { status: 'completed' };
}
