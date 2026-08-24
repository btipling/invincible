/**
 * backend-agents B12 (#806) — `persistStep`: the **persist** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin shell over the B7/B8 worker persist seam (`persistTranscriptSegment` +
 * envelope meta overlay, `lib/agent/turnWorkerPersist.ts`). Per plan #806
 * non-goals, the *real* B7/B8 wiring (Blob PUT + `meta.transcriptPointer` LWW
 * advance + envelope overlay) lands in **B13** ("persist wiring is B13").
 * This B12 step establishes the step boundary + terminal-status contract and
 * ships an **in-memory persists seam for tests** (matrix case 7), keeping the
 * file's static closure FREE of the banned Blob-store surface so the
 * `'use workflow'` entry importing it stays inside the B11 deploy-gate lock
 * (regression: `lib/workflows/staticGraph.test.ts`).
 *
 * **Zero non-serializable step args**: the step receives plain values only
 * (`turnRunId` = the Workflow run id, **never** session id, plan lock + the
 * serialized delta log for replay). No closures / seams cross the boundary; the
 * persist store is re-resolved *inside* the step via the injected seam
 * (`deps.persist`) — the engine/entry wires the real B7/B8 seam at B13.
 *
 * Business errors are values: a persist failure returns `{ok:false, code, error}`
 * (the loop terminates cleanly; the writable is still closed).
 */

/** The B7/B8 persist seam surface this step shells (store-ish, serializable-safe). */
export interface PersistStepSeam {
  /**
   * Persist one terminal turn segment server-side. Contract mirrors B7
   * (`persistTranscriptSegment`) but is deliberately store-agnostic here so this
   * file does not import the Banned Blob module. The engine/entry provides the
   * real seam at B13; tests inject an in-memory seam.
   */
  persist(input: {
    turnRunId: string;
    deltas: ReadonlyArray<unknown>;
    content: string;
  }): Promise<
    | { ok: true; objectId?: string; status: 'completed' }
    | { ok: false; code: string; error: string }
  >;
}

/** Serialized `persistStep` step args — plain values only. */
export interface PersistStepArgs {
  /** Workflow run id — NEVER session id (plan lock). */
  turnRunId: string;
  /** Delta log (orchestrator-local) to persist for replay reconstruction. */
  deltas: ReadonlyArray<unknown>;
}

/** Injected step deps — the seam (tests: in-memory; B13: real B7/B8 blob). */
export interface PersistStepDeps {
  persist: PersistStepSeam;
}

/** Fail-closed step result (terminal status). */
export type PersistStepResult =
  | { ok: true; status: 'completed'; turnRunId: string }
  | { ok: false; code: string; error: string };

/**
 * Run the persist terminal as a workflow step: re-resolves the persist seam
 * in-step and returns terminal status as a value.
 */
export async function persistStep(
  deps: PersistStepDeps,
  args: PersistStepArgs,
): Promise<PersistStepResult> {
  'use step';

  const content = JSON.stringify({ deltas: args.deltas });
  const result = await deps.persist.persist({
    turnRunId: args.turnRunId,
    deltas: args.deltas,
    content,
  });
  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  return { ok: true, status: 'completed', turnRunId: args.turnRunId };
}

/** An in-memory persist seam for tests / non-production (B13 replaces the seam). */
export function createInMemoryPersistSeam(): {
  seam: PersistStepSeam;
  persisted: Array<{ turnRunId: string; content: string }>;
} {
  const persisted: Array<{ turnRunId: string; content: string }> = [];
  const seam: PersistStepSeam = {
    async persist(input) {
      persisted.push({ turnRunId: input.turnRunId, content: input.content });
      return { ok: true, objectId: `seg_mem_${persisted.length}`, status: 'completed' };
    },
  };
  return { seam, persisted };
}
