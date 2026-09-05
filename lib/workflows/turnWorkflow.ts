/**
 * backend-agents B12 (#806) — `turnWorkflow`: the `"use workflow"` entry for one
 * durable prompt run.
 *
 * Thin directive carrier that:
 *  - adapts durable SSE write/close `'use step'` wrappers (`writeTurnSse` /
 *    `closeTurnSse`) — tokens ride Data Written, never step events; stream I/O
 *    is illegal in `'use workflow'` (plan #842);
 *  - composes the three `'use step'` wrappers (`modelGenerateStep`,
 *    `toolExecuteStep`, `persistStep`) into the loop core's step-fn contracts;
 *  - runs the orchestrator while-loop (`runTurnLoop`) per the umbrella #794
 *    Architecture lock, with the 512-step cap and writable close on every
 *    terminal path;
 *  - returns the terminal turn status as a plain value.
 *
 * **Static graph inside the B11 deploy-gate lock:** the entry's import closure is
 * only the three step wrappers (whose own closures are clean), the loop core,
 * and the `workflow` SDK bare specifier — NO db / mcp / blob / `node:crypto` /
 * `node:dns` reach. The persist step notably does NOT import the Blob store
 * (that wiring is B13; this entry stays deploy-gate-clean).
 *
 * **No `/api/agent` fallback**, no wrapping `runAgentStream`/`streamText`+`execute`
 * in one step. `turnRunId` = the Workflow run id, never session id.
 *
 * **Serializable-only args (adversarial L1):** the entry takes plain serializable
 * values only (`userMessage`, `modelId`, `scope`, optional `persistRunBind`) —
 * the tool world (registry/secrets/signal) and the persist seam are resolved
 * INSIDE the steps. No closures / AbortSignal / functions are ever passed into
 * a `'use step'` function. The route MUST NOT pass a `tools` dict — tool schemas
 * are assembled in-step via the shared `assembleDurableToolWorld` helper so the
 * model sees the same tools the execute step can run.
 *
 * Wiring note (B13/C14): this B12 row ships the directive-composed loop shape;
 * the production `start(runTurnWorkflow, [args])` route + real B7/B8 Blob seam +
 * request-scoped model/registry resolution are the engine rows (C14+).
 */

import { getWorkflowMetadata } from 'workflow';
import { TURN_WALL_CLOCK_MAX_MS } from '../sessionCloudCaps';
import {
  runTurnLoop,
  type PersistStepFn,
  type ToolStepFn,
  type ModelStepFn,
  type TurnWritable,
  type TurnLoopResult,
  type PersistRunBind,
} from './turnLoop';
import { modelGenerateStep } from './modelGenerateStep';
import { toolExecuteStep } from './toolExecuteStep';
import { persistStep } from './persistStep';
import { writeTurnSse, closeTurnSse } from './turnSseStep';

/**
 * `'use workflow'` run args — plain serializable values only.
 *
 * `turnRunId` is intentionally NOT an arg: `start()` returns the run id only
 * after it is enqueued, so `turnRunId` cannot be supplied from the boundary.
 * The entry derives it in-workflow from `getWorkflowMetadata().workflowRunId`
 * (= the route-side `run.runId`, never the session id).
 *
 * `tools` is intentionally REMOVED: the route MUST NOT pass a tools dict.
 * Tool schemas are assembled in-step via the shared `assembleDurableToolWorld`
 * helper — the model must see the same tools the execute step can run.
 */
export interface TurnWorkflowArgs {
  userMessage: string;
  modelId: string;
  /** Serializable session scope for in-step seam construction (prod path). */
  scope: { tenantId: string; userId: string; sessionId: string };
  /**
   * Pre-run sandbox **bind** state (B13): `cwd` + `activeSandboxId`. Supplied by
   * the engine (C14) at `start()` — this is sandbox bind known before the run,
   * NOT "last deltas" (those do not exist at start). The per-turn checkpoint +
   * usage projections are **derived** in-loop at persist time (adversarial L1).
   * Plain serializable values only.
   */
  persistRunBind?: PersistRunBind;
  /**
   * Optional resolved reasoning-effort token (plan #897). Serializable scalar;
   * the HTTP boundary resolves Gateway/env/default — this step does not fetch.
   */
  reasoning?: string;
  /**
   * Seeded prior orchestrator rows (plan #936, source #549) — the persisted
   * model-messages projection read from the session-bound Blob object at
   * `POST /api/turns`. Forwarded to `runTurnLoop` so the initial `messages`
   * becomes `[...priorMessages, {role:'user'}]`. Plain serializable values
   * only. Absent = legacy/first turn.
   */
  priorMessages?: ReadonlyArray<unknown>;
  /**
   * Per-turn freshness-reminder pointer (plan #941, source #693) — the
   * `meta.freshnessReminderPointer` value read (sanitize-only) at
   * `POST /api/turns`. Forwarded to `runTurnLoop` so the FIRST model round
   * can fold the volatile reminder in-step (fail-open). Plain serializable
   * scalar — the pointer never becomes run state beyond this arg. Absent =
   * no prior reminder.
   */
  freshnessReminderPointer?: string;
}

/**
 * One durable prompt run as a Workflows entry. Binds the SSE writable, adapts
 * the three step wrappers into the loop contract, runs the while-loop, and
 * returns the terminal status.
 */
export async function turnWorkflow(
  args: TurnWorkflowArgs,
): Promise<TurnLoopResult> {
  'use workflow';

  // `turnRunId` is DERIVED in-workflow: `start()` returns the run id only after
  // enqueue, so it can never be a `start()` arg. Thread the workflow's own run
  // id to the loop → terminal persist, so the persist seam's `turnRunId` equals
  // the route-side `run.runId` (never the session id).
  const { workflowRunId, workflowStartedAt } = getWorkflowMetadata();

  // 1-hour wall-clock cap (plan #923, Bjorn-authorized): derive a deterministic
  // DEADLINE from the SDK-pinned, replay-stable `workflowStartedAt` + the cap —
  // NEVER a live `Date.now()` in this workflow body (replay determinism). The
  // loop + step shells compare the serialized `deadlineAt` number against the
  // step VMs' real clocks; no signal/closure/Date ever crosses a step boundary.
  const deadlineAt = workflowStartedAt.getTime() + TURN_WALL_CLOCK_MAX_MS;

  // Stream I/O is `'use step'` only (plan #842). Do NOT call getWriter /
  // write / close in this `'use workflow'` function — the Workflows VM throws
  // `Not supported in workflow functions`. I/O lives in writeTurnSse / closeTurnSse.
  const loopWritable: TurnWritable = {
    write: (line) => writeTurnSse(line),
    close: () => closeTurnSse(),
  };

  const modelStep: ModelStepFn = async ({
    messages,
    persistRunBind,
    disableTools,
    wrapUp,
    freshnessReminderPointer,
  }) => {
    return modelGenerateStep({
      messages,
      modelId: args.modelId,
      userId: args.scope.userId,
      scope: args.scope,
      // Use the RUNNING bind from the loop (updated after each successful
      // change_dir/meta_sandbox_switch), NOT the stale start snapshot. The
      // model must see FS tools for the CURRENT sandbox + cwd.
      persistRunBind: persistRunBind ?? args.persistRunBind,
      deadlineAt,
      ...(disableTools ? { disableTools: true } : {}),
      ...(wrapUp !== undefined ? { wrapUp } : {}),
      ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
      // Plan #941: the loop passes this ONLY on the first non-wrap-up round —
      // forward it verbatim (the step folds the reminder in-step, fail-open).
      ...(freshnessReminderPointer !== undefined
        ? { freshnessReminderPointer }
        : {}),
    });
  };
  const toolStep: ToolStepFn = async ({ calls, freshnessSeed, persistRunBind }) => {
    return toolExecuteStep({
      calls,
      freshnessSeed,
      scope: args.scope,
      // Use the RUNNING bind from the loop, NOT the stale start snapshot.
      persistRunBind: persistRunBind ?? args.persistRunBind,
      deadlineAt,
    });
  };
  // Forward EVERYTHING the loop passes including the derived `fold` — a
  // destructure that drops it would silently no-op DoD rows 3/5 (adversarial L1).
  const persistStepFn: PersistStepFn = async ({ turnRunId, deltas, fold, terminal }) => {
    return persistStep({
      turnRunId,
      deltas,
      ...(fold !== undefined ? { fold } : {}),
      ...(terminal !== undefined ? { terminal } : {}),
      scope: args.scope,
    });
  };

  try {
    return await runTurnLoop(
      {
        modelStep,
        toolStep,
        persistStep: persistStepFn,
        writable: loopWritable,
        turnRunId: workflowRunId,
        deadlineAt,
        ...(args.persistRunBind !== undefined ? { persistRunBind: args.persistRunBind } : {}),
      },
      {
        userMessage: args.userMessage,
        ...(args.priorMessages !== undefined
          ? { priorMessages: args.priorMessages }
          : {}),
        ...(args.freshnessReminderPointer !== undefined
          ? { freshnessReminderPointer: args.freshnessReminderPointer }
          : {}),
      },
    );
  } finally {
    await closeTurnSse();
  }
}
