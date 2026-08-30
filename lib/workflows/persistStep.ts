/**
 * backend-agents B12 (#806) — `persistStep`: the **persist** half of the durable
 * turn loop, as one `'use step'` boundary.
 *
 * Thin shell over the B7/B8 worker persist seam (`persistTranscriptSegment` +
 * envelope meta overlay, `lib/agent/turnWorkerPersist.ts`). In **production**
 * the seam is constructed IN-STEP from the serializable `scope` arg (the route
 * MUST NOT wire the module-level resolver — Vercel step VMs don't share the
 * route's module state). `setPersistSeamResolver` is a TEST-ONLY override: when
 * set (tests), it wins; when unset (prod), the step constructs the real
 * Blob+envelope seam from `scope`.
 *
 * The B11 walker treats `'use step'` files as leaves, so this file's imports
 * (including `lib/di` / Blob-store surface) do NOT pollute the workflow entry's
 * closure — the deploy-gate lock stays intact (regression:
 * `lib/workflows/staticGraph.test.ts`).
 *
 * **Zero non-serializable step args** (plan lock + adversarial L1): the step
 * receives plain serializable values only (`turnRunId` = the Workflow run id,
 * **never** session id, plan lock + the serialized delta log for replay). No
 * closures / seams are passed as args.
 *
 * Business errors are values: a persist failure returns `{ok:false, code, error}`.
 * Persist `{ok:false}` of any code does not kill a useful turn; the writable is still closed.
 */
import { checkpointToSnapshotMessages } from '../agent/messageCheckpoint';
import { logTurnPersist } from './turnLog';

/** Overlay status for a persist write. Omitted/`true` stays completed (today). */
export function persistOverlayStatus(
  terminal?: boolean,
): 'completed' | 'running' {
  return terminal === false ? 'running' : 'completed';
}

/** Serialized final-state fold (B13) — the run-level worker keys the persist
 *  step folds onto envelope `meta` via the B8 overlay. Plain serializable
 *  values only (Vercel serializes every `'use step'` arg). Per the plan lock,
 *  the checkpoint is a bounded `{role,content}[]` projection the real seam
 *  writes as its own Blob object — only the pointer rides in `meta`. */
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
   * Persist one turn segment server-side. Contract mirrors B7
   * (`persistTranscriptSegment`) but is deliberately store-agnostic here so this
   * file does not import the Banned Blob module. The engine/entry provides the
   * real seam at B13 (`lib/agent/turnPersistSeam.ts`); tests inject an
   * in-memory seam. The seam returns completed or running status + the
   * persisted pointers.
   */
  persist(input: {
    turnRunId: string;
    deltas: ReadonlyArray<unknown>;
    content: string;
    /** Run final-state fold (cwd/usage/sandbox/checkpoint) — optional. */
    fold?: PersistStepFold;
    /**
     * Default true. Mid-turn writes pass false so B8 overlays `running`
     * and the step result status is `running`.
     */
    terminal?: boolean;
  }): Promise<
    | {
        ok: true;
        objectId?: string;
        checkpointPointer?: string;
        status: 'completed' | 'running';
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
  /**
   * Default true. Mid-turn writes pass false so B8 overlays `running`.
   * Omit or `true` keeps every existing single-call test completed.
   */
  terminal?: boolean;
  /**
   * Serializable session scope for in-step seam construction (prod path).
   * When the module-level resolver is unset (production — the route must NOT
   * wire it), the step constructs the real Blob+envelope seam from this scope.
   * Plain serializable values only. `sessionId` is also the snapshot `id`.
   */
  scope?: { tenantId: string; userId: string; sessionId: string };
}

/** Fail-closed step result (completed or mid-turn running). */
export type PersistStepResult =
  | {
      ok: true;
      status: 'completed' | 'running';
      turnRunId: string;
      objectId?: string;
      checkpointPointer?: string;
    }
  | { ok: false; code: string; error: string };

/**
 * Stamp `updatedAt` onto a JSON object string. Returns null when `content` is
 * not a JSON object (array/primitive/invalid) so the caller can fail closed.
 * persistStep never stamps a clock; the seam is the only OverlayClock site.
 */
export function stampSnapshotUpdatedAt(
  content: string,
  updatedAt: number,
): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return JSON.stringify({ ...(parsed as Record<string, unknown>), updatedAt });
  } catch {
    return null;
  }
}

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

  const sessionId = args.scope?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    logTurnPersist({
      ok: false,
      terminal: args.terminal !== false,
      turnRunId: args.turnRunId,
      code: 'invalid_scope',
    });
    return {
      ok: false,
      code: 'invalid_scope',
      error: 'persistStep requires scope.sessionId',
    };
  }

  // Resolve the persist seam: tests wire it via setPersistSeamResolver (the
  // resolver is set → no throw → test seam wins). In production the resolver
  // is UNSET (the route MUST NOT wire it — Vercel step VMs don't share the
  // route's module state), so we fall through to construct the real
  // Blob+envelope seam from the serializable scope.
  let seam: PersistStepSeam;
  try {
    seam = resolvePersistSeam();
  } catch {
    if (!args.scope) {
      return {
        ok: false,
        code: 'invalid_scope',
        error:
          'persistStep: no persist seam wired and no scope provided — the route must pass scope on start() args.',
      };
    }
    // Production path: construct the real B7/B8/B6 seam in-step. The DI root
    // import is a 'use step' leaf (the B11 walker does not follow it), so the
    // workflow entry's closure stays clean.
    const { createProdServices } = await import('../di/index');
    seam = createProdServices().createPersistStepSeam(args.scope);
  }

  // Tool results already live on checkpoint messages. Deltas stay step args
  // for Workflows replay — they must not double into the 8 MiB Blob object.
  const content = JSON.stringify({
    id: sessionId,
    messages: checkpointToSnapshotMessages(args.fold?.checkpoint ?? []),
  });
  const result = await seam.persist({
    turnRunId: args.turnRunId,
    deltas: args.deltas,
    content,
    ...(args.fold !== undefined ? { fold: args.fold } : {}),
    ...(args.terminal !== undefined ? { terminal: args.terminal } : {}),
  });
  if (!result.ok) {
    logTurnPersist({
      ok: false,
      terminal: args.terminal !== false,
      turnRunId: args.turnRunId,
      code: result.code,
    });
    return { ok: false, code: result.code, error: result.error };
  }
  logTurnPersist({
    ok: true,
    terminal: args.terminal !== false,
    status: result.status,
    turnRunId: args.turnRunId,
  });
  return {
    ok: true,
    status: result.status,
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
      const stamped = stampSnapshotUpdatedAt(input.content, 1) ?? input.content;
      persisted.push({ turnRunId: input.turnRunId, content: stamped });
      return {
        ok: true,
        objectId: `seg_mem_${persisted.length}`,
        status: persistOverlayStatus(input.terminal),
      };
    },
  };
  return { seam, persisted };
}
