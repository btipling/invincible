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
 *    Architecture lock, with the 256-step cap and writeable close on every
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
 * Wiring note (B13/C14): this B12 row ships the directive-composed loop shape;
 * the production `start(runTurnWorkflow, [args])` route + real B7/B8 Blob seam +
 * request-scoped model/registry resolution are the engine rows (C14+). The deps
 * are injected so the entry's logic is testable and stays layer-faithful.
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
import { persistStep, type PersistStepSeam } from './persistStep';

/** Leaf deps the entry wires into the loop (seams injected; wrappers re-resolve). */
export interface TurnWorkflowDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry?: Record<string, any>;
  persistSeam: PersistStepSeam;
  /** Cap override for tests (defaults to MAX_WORKFLOW_STEPS). */
  maxSteps?: number;
}

/** `'use workflow'` run args — plain serializable values only. */
export interface TurnWorkflowArgs {
  turnRunId: string;
  userMessage: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  modelId: string;
}

/**
 * One durable prompt run as a Workflows entry. Binds the SSE writable, adapts
 * the three step wrappers into the loop contract, runs the while-loop, and
 * returns the terminal status.
 */
export async function turnWorkflow(
  deps: TurnWorkflowDeps,
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
    const r = await modelGenerateStep({
      messages,
      tools: args.tools,
      modelId: args.modelId,
    });
    return r;
  };
  const toolStep: ToolStepFn = async ({ toolName, toolCallId, callArgs }) => {
    const r = await toolExecuteStep(
      { registry: deps.registry ?? {}, secrets: [], signal: undefined },
      { toolName, callArgs },
    );
    return r;
  };
  const persistStepFn: PersistStepFn = async ({ turnRunId, deltas }) => {
    const r = await persistStep({ persist: deps.persistSeam }, { turnRunId, deltas });
    return r;
  };

  return runTurnLoop(
    {
      modelStep,
      toolStep,
      persistStep: persistStepFn,
      writable: loopWritable,
      maxSteps: deps.maxSteps,
      turnRunId: args.turnRunId,
    },
    { userMessage: args.userMessage },
  );
}
