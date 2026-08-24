/**
 * backend-agents B12 (#806) — `turnWorkflow`: the `"use workflow"` entry for one
 * durable prompt run.
 *
 * Thin directive carrier that:
 *  - binds the SSE writable from the Workflows SDK (`getWritable()`) — tokens
 *    ride this stream (Data Written, never step events);
 *  - composes the three `'use step'` wrappers (`modelGenerateStep`,
 *    `toolExecuteStep`, `persistStep`) into the loop core's step-fn contracts;
 *  - runs the orchestrator while-loop (`runTurnLoop`) per the umbrella #794
 *    Architecture lock, with the 256-step cap and writable close on every
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
 * values only (`turnRunId`, `userMessage`, tool SCHEMAS, `modelId`) — the tool
 * world (registry/secrets/signal) and the persist seam are resolved INSIDE the
 * steps from their module-level resolvers, which the engine (C14) / B13 wires at
 * the boundary before `start()`. No closures / AbortSignal / functions are ever
 * passed into a `'use step'` function.
 *
 * Wiring note (B13/C14): this B12 row ships the directive-composed loop shape;
 * the production `start(runTurnWorkflow, [args])` route + real B7/B8 Blob seam +
 * request-scoped model/registry resolution are the engine rows (C14+).
 */

import { getWritable } from 'workflow';
import {
  runTurnLoop,
  type PersistStepFn,
  type ToolStepFn,
  type ModelStepFn,
  type TurnWritable,
  type TurnLoopResult,
} from './turnLoop';
import { modelGenerateStep } from './modelGenerateStep';
import { toolExecuteStep } from './toolExecuteStep';
import { persistStep, type PersistStepFold } from './persistStep';

/** `'use workflow'` run args — plain serializable values only. */
export interface TurnWorkflowArgs {
  turnRunId: string;
  userMessage: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  modelId: string;
  /**
   * Run final-state fold (B13): cwd/usage/activeSandboxId + the bounded
   * checkpoint projection, threaded to the terminal persist step. Plain
   * serializable values only. Supplied by the engine (C14) from the run's last
   * generate/tool deltas.
   */
  persistFold?: PersistStepFold;
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

  // ONE getWritable() handle for the run — the SSE wire (tokens = Data Written).
  // The SDK returns a stream (web `WritableStream`); looping writes await its
  // writer so a closed stream rejects cleanly (the core closes it on every path).
  const sink = getWritable<string>();
  const writer = sink.getWriter();
  const loopWritable: TurnWritable = {
    write: (line) => writer.write(line),
    close: () => writer.close(),
  };

  const modelStep: ModelStepFn = async ({ messages }) => {
    return modelGenerateStep({
      messages,
      tools: args.tools,
      modelId: args.modelId,
    });
  };
  const toolStep: ToolStepFn = async ({ toolName, toolCallId, callArgs, freshnessSeed }) => {
    return toolExecuteStep({
      toolName,
      callArgs,
      freshnessSeed,
    });
  };
  const persistStepFn: PersistStepFn = async ({ turnRunId, deltas }) => {
    return persistStep({ turnRunId, deltas });
  };

  return runTurnLoop(
    {
      modelStep,
      toolStep,
      persistStep: persistStepFn,
      writable: loopWritable,
      turnRunId: args.turnRunId,
      ...(args.persistFold !== undefined ? { persistFold: args.persistFold } : {}),
    },
    { userMessage: args.userMessage },
  );
}
