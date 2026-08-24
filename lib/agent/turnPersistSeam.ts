/**
 * backend-agents B13 (#807) — the REAL worker Blob persist seam (B7 + B8 + B6).
 *
 * This module is the engine/dispatch-boundary construction of the terminal
 * persist step: given injected `BlobTranscriptStore` + `ServerSessionStore`
 * handles and a session scope, it returns a `PersistStepSeam` value that
 * persists ONE terminal turn through the real, already-shipped seams:
 *
 *  1. **Checkpoint (B6)** — the bounded `{role, content}[]` projection is
 *     written as its OWN Blob object (`truncateMessageCheckpoint` bounds it to
 *     the B6 row/byte caps). Only the object **id** rides in envelope `meta`
 *     (`checkpointPointer`) — never the 1 MiB `meta` body.
 *  2. **Transcript (B7)** — `persistTranscriptSegment` writes the appended
 *     segment object and advances `meta.transcriptPointer` only on a successful
 *     PUT (fail-closed, LWW — already shipped).
 *  3. **Terminal worker overlay (B8)** — `overlayWorkerMeta` sets the
 *     terminal worker-owned keys via a copy-forward PATCH: `turnStatus=
 *     'completed'`, the real `turnRunId`, `checkpointPointer`, and
 *     cwd / activeSandboxId / usage folded from the run's final state. Host
 *     keys are preserved byte-for-byte, and a `turnRunId` equal to the session
 *     id is SKIPPED (B8 already enforces) so a live-less id can never lock the
 *     next prompt.
 *
 * **Deploy-gate (B11 lock) boundary:** this module imports the Banned Blob /
 * worker-persist surface (`../sessions/blobStore`, `turnWorkerPersist`,
 * `workerMetaOverlay`) — that is OK **because this module is wired from the
 * composition root / engine boundary, never statically imported by the
 * `'use workflow'` entry**. The walked entry (`turnWorkflow.ts`) reaches the
 * seam only through `setPersistSeamResolver`'s injected VALUE (a type-only
 * ref in `persistStep.ts`, erased, never a runtime reach), so the entry
 * closure stays inside the B11 deploy-gate lock (regression:
 * `lib/workflows/staticGraph.test.ts` / `turnLoop.test.ts`).
 *
 * Layer: server-side `lib/*` only — no DOM, no Wasm, no Vercel route. It
 * constructs no I/O in its own body (di-gate): the blob/envelope stores are
 * injected, so this is safe to assemble at the DI root.
 */
import {
  TURN_MSG_CHECKPOINT_MAX_BYTES,
} from '../sessionCloudCaps';
import {
  newBlobObjectId,
  isObjectIdBoundTo,
  type BlobTranscriptStore,
  type ObjectScope,
} from '../sessions/blobStore';
import {
  isEnvelopeStore,
  type ServerSessionStore,
  type SessionEnvelope,
  type SessionRecordKey,
} from '../sessions/sessionStore';
import {
  truncateMessageCheckpoint,
  type CheckpointRow,
} from './messageCheckpoint';
import { persistTranscriptSegment } from './turnWorkerPersist';
import {
  overlayWorkerMeta,
  type WorkerMetaPatch,
} from './workerMetaOverlay';
import type {
  PersistStepFold,
  PersistStepResult,
  PersistStepSeam,
} from '../workflows/persistStep';

/** Worker-authored envelope clock source for the terminal B8 overlay (LWW). */
export type OverlayClock = (storedUpdatedAt: number) => number;

/** The real seam's construction deps — all injected (di-gate clean). */
export interface TurnPersistSeamDeps {
  blobStore: BlobTranscriptStore;
  envelopeStore: ServerSessionStore;
  /** Session scope every object + envelope write is bound to (confused-deputy). */
  scope: ObjectScope;
  /**
   * Optional envelope-clock source for the terminal B8 overlay (LWW). Defaults
   * to a strictly-newer auto-bump (`max(now, stored+1)`) so the B7→B8 double
   * write can NEVER self-conflict on a real run. Tests may inject a fixed
   * (stale/equal) clock to prove the seam surfaces an underlying B8 `lww_conflict`
   * as a `{ok:false}` value with no partial terminal write (plan matrix 7).
   */
  overlayClock?: OverlayClock;
}

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Build the real B7/B8/B6 persist seam for one session scope. The caller (C14
 * engine route / composition root) constructs this per session and installs it
 * via `setPersistSeamResolver` before `start(runTurnWorkflow, …)`.
 *
 * Business errors are **values**: every failure path returns `{ ok:false, code,
 * error }` (B7/B8 codes surfaced verbatim) — the loop terminates cleanly.
 * Never throws.
 */
export function createTurnPersistSeam(
  deps: TurnPersistSeamDeps,
): PersistStepSeam {
  const { blobStore, envelopeStore, scope } = deps;
  const key: SessionRecordKey = {
    tenantId: scope.tenantId,
    userId: scope.userId,
    sessionId: scope.sessionId,
  };
  // Narrow to the envelope-capable subtype ONLY for the terminal-clock read; the
  // B7/B8 calls receive the full `ServerSessionStore` and validate it themselves
  // (fail-closed `not_envelope_store`).
  const envelope = isEnvelopeStore(envelopeStore) ? envelopeStore : null;
  const clock: OverlayClock =
    deps.overlayClock ??
    ((storedUpdatedAt) => Math.max(Date.now(), storedUpdatedAt + 1));

  return {
    async persist(input: {
      turnRunId: string;
      deltas: ReadonlyArray<unknown>;
      content: string;
      fold?: PersistStepFold;
    }): Promise<PersistStepResult> {
      // 0. Terminal meta patch accumulates B7's pointer + B8's worker keys.
      //    Start with the worker-owned terminal keys only (B8 copy-forward keeps
      //    every host key + absent worker key byte-for-byte).
      const patch: WorkerMetaPatch = {
        turnStatus: 'completed',
        turnRunId: input.turnRunId,
      };

      // 1. Checkpoint (B6): write the bounded `{role,content}` projection as its
      //    OWN Blob object; only the object id rides in meta.
      let checkpointPointer: string | undefined;
      if (input.fold?.checkpoint !== undefined) {
        const bounded = truncateMessageCheckpoint(input.fold.checkpoint);
        const ckptObjectId = newBlobObjectId(scope);
        if (!isObjectIdBoundTo(ckptObjectId, scope)) {
          return {
            ok: false,
            code: 'checkpoint_write_failed',
            error: 'minted checkpoint object id is not bound to the session scope.',
          };
        }
        try {
          await blobStore.writeSegment({
            objectId: ckptObjectId,
            content: JSON.stringify(bounded.rows),
            contentType: 'application/json',
            maxBytes: TURN_MSG_CHECKPOINT_MAX_BYTES,
          });
          checkpointPointer = ckptObjectId;
          patch.checkpointPointer = ckptObjectId;
        } catch (err) {
          return {
            ok: false,
            code: 'checkpoint_write_failed',
            error: `checkpoint blob write failed: ${toMessage(err)}`,
          };
        }
      }

      // 2. Transcript (B7): write the appended segment + advance transcriptPointer
      //    only on a successful PUT (fail-closed, LWW). A failure here returns a
      //    value; the pointer is never advanced on a partial write.
      const seg = await persistTranscriptSegment({
        store: blobStore,
        envelopeStore,
        scope,
        segment: {
          content: input.content,
          contentType: 'application/json',
        },
      });
      if (!seg.ok) return { ok: false, code: seg.code, error: seg.error };

      // 3. Terminal worker overlay (B8): set the remaining worker keys from the
      //    run's final-state fold. cwd/usage/sandbox are threaded as serializable
      //    step args and sanitized by B8 (poison → drop THAT key to unset, never a
      //    clear of siblings/host).
      if (input.fold?.cwd !== undefined) patch.logicalCwd = input.fold.cwd;
      if (input.fold?.activeSandboxId !== undefined) {
        patch.activeSandboxId = input.fold.activeSandboxId;
      }
      if (input.fold?.usage !== undefined) patch.usage = input.fold.usage;

      // B8 LWW guard needs a strictly-newer clock than the post-B7 envelope.
      let fresh: SessionEnvelope | null = null;
      if (envelope) {
        try {
          fresh = await envelope.readEnvelope(key);
        } catch {
          fresh = null;
        }
      }
      const updatedAt = clock(fresh?.updatedAt ?? 0);

      const overlay = await overlayWorkerMeta({
        envelopeStore,
        key,
        patch,
        updatedAt,
      });
      if (!overlay.ok) return { ok: false, code: overlay.code, error: overlay.error };

      return {
        ok: true,
        status: 'completed',
        turnRunId: input.turnRunId,
        objectId: seg.objectId,
        ...(checkpointPointer !== undefined ? { checkpointPointer } : {}),
      };
    },
  };
}
