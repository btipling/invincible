import { stepCountIs, isLoopFinished } from 'ai';

/**
 * backend-agents B12 (#806) cleanup — extracted `resolveAgentStopWhen`.
 *
 * The stop-when resolver is a pure `ai`-SDK helper (model-ended loop, or
 * `stepCountIs` when an optional ceiling is set). It was originally defined in
 * `runAgent.ts` and imported by the B9 core `generateOneRound`. Hoisting it into
 * its own module keeps `generateOneRound`'s static closure free of `runAgent`
 * (which drags in the whole agent backend — tools, sandbox, db, mcp, blobStore,
 * `node:crypto`/`node:dns`) so B12's `'use workflow'` entry
 * (`lib/workflows/turnWorkflow.ts`) stays inside the B11 deploy-gate lock.
 *
 * Behavior is byte-identical to the prior definition; both `runAgent` and
 * `generateOneRound` now import from here.
 */
export function resolveAgentStopWhen(
  maxSteps: number | null | undefined,
): ReturnType<typeof stepCountIs> | ReturnType<typeof isLoopFinished> {
  if (maxSteps != null && Number.isFinite(maxSteps) && maxSteps >= 1) {
    return stepCountIs(Math.floor(maxSteps));
  }
  return isLoopFinished();
}
