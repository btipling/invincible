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
 * **Zero non-serializable step args** (plan lock + adversarial L1): the step
 * receives plain serializable values only (`turnRunId` = the Workflow run id,
 * **never** session id, plan lock + the serialized delta log for replay). No
 * closures / seams are passed as args — the persist store is re-resolved
 * *inside* the step from the module-level resolver (`setPersistSeamResolver`),
 * which the engine/entry wires to the real B7/B8 seam at B13.
 *
 * Business errors are values: a persist failure returns `{ok:false, code, error}`
 * (the loop terminates cleanly; the writable is still closed).
 */

/**
 * Serialized final-state fold (B13) — the run-level worker keys the terminal
 * persist step folds onto envelope `meta` via the B8 overlay. Plain
 * serializable values only (Vercel serializes every `'use step'` arg). Per the
 * plan lock, the checkpoint is a bounded `{role,content}[]` projection the real
 * seam writes as its own Blob object — only the pointer rides in `meta`.
 */
export interface PersistStepFold {
  /** Workspace-relative `logicalCwd` folded from the last generate/tool deltas. */
  cwd?: string;
  /** `activeSandboxId` folded from the run's bind state. */
  activeSandboxId?: string;
  /** Provider usage summary object (B8 encodes/bounds it for `meta.usage`). */
  usage?: unknown;
  /** Bounded `{role,content}` checkpoint projection (discarded in-memory seams). */
  checkpoint?: Array<{ role: string; content: string }>;
}

/** The B7/B8 persist seam surface this step shells (store-ish, serializable-safe). */
export interface PersistStepSeam {
  /**
   * Persist one terminal turn segment server-side. Contract mirrors B7
   * (`persistTranscriptSegment`) but is deliberately store-agnostic here so this
   * file does not import the Banned Blob module. The engine/entry provides the
   * real seam at B13 (`lib/agent/turnPersistSeam.ts`); tests inject an
   * in-memory seam. The seam returns terminal status + the persisted pointers.
   */
  persist(input: {
    turnRunId: string;
    deltas: ReadonlyArray<unknown>;
    content: string;
    /** Run final-state fold (cwd/usage/sandbox/checkpoint) — optional. */
    fold?: PersistStepFold;
  }): Promise<
    | {
        ok: true;
        objectId?: string;
        checkpointPointer?: string;
        status: 'completed';
      }
    | { ok: false; code: string; error: string }
  >;
}

/** Serialized `persistStep` step args — plain values only. */
export interface PersistStepArgs {
  /** Workflow run id — NEVER session id (plan lock). */
  turnRunId: string;
  /** Delta log (orchestrator-local) to persist for replay reconstruction. */
  deltas: ReadonlyArray<unknown>;
  /** Run final-state fold (B13) — plain serializable values only. */
  fold?: PersistStepFold;
}

/** Fail-closed step result (terminal status). */
export type PersistStepResult =
  | {
      ok: true;
      status: 'completed';
      turnRunId: string;
      objectId?: string;
      checkpointPointer?: string;
    }
  | { ok: false; code: string; error: string };

/**
 * Run the persist terminal as a workflow step: re-resolves the persist seam
 * in-step (from the module-level resolver) and returns terminal status as a
 * value. The step takes ONLY serializable args (`turnRunId`, `deltas`) — the
 * seam is a `'use step'`-unsafe function, so it is resolved inside the step via
 * {@link setPersistSeamResolver}, never passed as an arg (adversarial L1).
 */
export async function persistStep(
  args: PersistStepArgs,
): Promise<PersistStepResult> {
  'use step';

  const seam = resolvePersistSeam();
  const content = JSON.stringify({ deltas: args.deltas });
  const result = await seam.persist({
    turnRunId: args.turnRunId,
    deltas: args.deltas,
    content,
    ...(args.fold !== undefined ? { fold: args.fold } : {}),
  });
  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  return {
    ok: true,
    status: 'completed',
    turnRunId: args.turnRunId,
    ...(result.objectId !== undefined ? { objectId: result.objectId } : {}),
    ...(result.checkpointPointer !== undefined
      ? { checkpointPointer: result.checkpointPointer }
      : {}),
  };
}

/**
 * Module-level injectable seam for the persist store (mirror of the tool-world
 * resolver). Wired once per run by the engine/entry at the boundary; read
 * in-step. Default FAILS CLOSED so a real run cannot silently no-op persist —
 * tests and the engine (B13/C14) wire the real/in-memory seam.
 */
let resolvePersistSeam: () => PersistStepSeam = () => {
  throw new Error(
    'persistStep: no persist seam wired — call setPersistSeamResolver (B13 wires the real B7/B8 Blob seam).',
  );
};

/** Wire the run-scoped persist-seam resolver (engine/entry boundary; tests inject too). */
export function setPersistSeamResolver(fn: () => PersistStepSeam): void {
  resolvePersistSeam = fn;
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
