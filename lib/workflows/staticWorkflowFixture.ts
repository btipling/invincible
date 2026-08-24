import { sleep } from 'workflow';

/**
 * Clean static-discipline fixture (backend-agents B11, plan #805).
 *
 * A `"use workflow"` entry that awaits a directive-marked `"use step"` — the
 * same shape as `fixtureWorkflow.ts` (sleep from `workflow`) but with a real
 * step awaited from the entry, per the plan lock ("steps are only callable
 * from workflow/step context"). It is **never dispatched** this row; the
 * static-graph regression (`staticGraph.test.ts`) walks this file's import
 * closure and asserts it reaches **zero** banned Workflow-bundle modules.
 *
 * Pure server-side fixture — never imported by Wasm/DOM.
 */
export async function staticWorkflowFixture(): Promise<{ status: 'completed' }> {
  'use workflow';

  await staticWorkflowStep();

  return { status: 'completed' };
}

/**
 * A real directive-marked step, awaited from the entry. Its static closure is
 * intentionally trivial (imports nothing of its own) so the fixture stays a
 * clean handshake for the closure walk.
 */
async function staticWorkflowStep(): Promise<void> {
  'use step';

  await sleep('2s');
}
