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
  applyPriorMessagesToSnapshotJson,
  snapshotMessagesFromUnknown,
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
import { persistOverlayStatus, stampSnapshotUpdatedAt } from '../workflows/persistStep';

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
   * write can NEVER **self**-conflict on a real run. Tests may inject a fixed
   * (stale/equal) clock to prove the seam surfaces an underlying B8
   * `lww_conflict` as a `{ok:false}` value with no partial **terminal** write
   * (plan matrix 7).
   *
   * **Partial-commit scope (honest, adversarial L1):** B7 and B8 are TWO stored
   * envelope upserts. On the B8-conflict path, B7's `meta.transcriptPointer`
   * advance (and a B6 checkpoint blob write) have ALREADY committed and are NOT
   * rolled back — the B8 conflict returns `{ok:false, code:'lww_conflict'}` with
   * the terminal worker keys unapplied but the pointer advanced + checkpoint
   * possibly orphaned. This is the pre-existing concurrent-host LWW residual of
   * composing two shipped writes (the default clock prevents the seam's own
   * B7→B8 from conflicting); we never claim atomicity across the pair.
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
      terminal?: boolean;
    }): Promise<PersistStepResult> {
      // 0. Worker meta patch accumulates B7's pointer + B8's worker keys.
      //    Start with the worker-owned keys only (B8 copy-forward keeps
      //    every host key + absent worker key byte-for-byte). Mid-turn
      //    writes overlay `running`; omitted/`true` stays `completed`.
      const status = persistOverlayStatus(input.terminal);
      const patch: WorkerMetaPatch = {
        turnStatus: status,
        turnRunId: input.turnRunId,
      };

      if (input.fold?.cwd !== undefined) patch.logicalCwd = input.fold.cwd;
      if (input.fold?.activeSandboxId !== undefined) {
        patch.activeSandboxId = input.fold.activeSandboxId;
      }
      if (input.fold?.usage !== undefined) patch.usage = input.fold.usage;

      let stored: SessionEnvelope | null = null;
      if (envelope) {
        try {
          stored = await envelope.readEnvelope(key);
        } catch (err) {
          return {
            ok: false,
            code: 'write_failed',
            error: `envelope read failed: ${toMessage(err)}`,
          };
        }
      }
      const updatedAt = clock(stored?.updatedAt ?? 0);

      // This-run checkpoint is not the full session. Suffix-merge onto a
      // parseable prior pointer so a newer overlay clock cannot LWW-wipe
      // earlier turns. Leftover `{ deltas }` (readable JSON, unparseable
      // snapshot) → this run only. A *bound* pointer whose object is missing
      // or not JSON must fail closed — Vercel Blob maps timeout/non-2xx to
      // `null`, and treating that like leftover deltas would LWW-clobber.
      let priorMessages = null;
      const pointer = stored?.meta?.transcriptPointer;
      if (typeof pointer === 'string' && isObjectIdBoundTo(pointer, scope)) {
        let raw: string | null;
        try {
          raw = await blobStore.read(pointer);
        } catch (err) {
          return {
            ok: false,
            code: 'write_failed',
            error: `bound transcriptPointer read failed: ${toMessage(err)}`,
          };
        }
        if (raw === null) {
          return {
            ok: false,
            code: 'write_failed',
            error:
              'bound transcriptPointer object is missing — refusing this-run-only replace.',
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return {
            ok: false,
            code: 'write_failed',
            error:
              'bound transcriptPointer body is not JSON — refusing this-run-only replace.',
          };
        }
        priorMessages = snapshotMessagesFromUnknown(parsed, scope.sessionId);
      }
      const merged =
        applyPriorMessagesToSnapshotJson(
          input.content,
          priorMessages,
          scope.sessionId,
        ) ?? input.content;
      const stamped = stampSnapshotUpdatedAt(merged, updatedAt);
      if (stamped === null) {
        return {
          ok: false,
          code: 'write_failed',
          error: 'persist content is not a JSON object — cannot stamp updatedAt.',
        };
      }

      // Checkpoint (B6): write the bounded `{role,content}` projection as its
      // OWN Blob object; only the object id rides in meta. Runs AFTER the
      // prior-read gate so a bound-pointer miss does not orphan a checkpoint.
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

      // Transcript (B7): write the stamped snapshot + advance transcriptPointer
      // only on a successful PUT (fail-closed, LWW). A failure here returns a
      // value; the pointer is never advanced on a partial write. NOTE (honest
      // partial-commit scope, adversarial L1): this is a SEPARATE committed
      // envelope upsert that B8's later overlay conflict does NOT roll back.
      const seg = await persistTranscriptSegment({
        store: blobStore,
        envelopeStore,
        scope,
        segment: {
          content: stamped,
          contentType: 'application/json',
        },
        // Empty envelope: mint at 0 so B8's overlay clock is strictly newer.
        // Stored envelopes ignore this and preserve their clock (B7).
        pointerUpdatedAt: 0,
      });
      if (!seg.ok) return { ok: false, code: seg.code, error: seg.error };

      const overlay = await overlayWorkerMeta({
        envelopeStore,
        key,
        patch,
        updatedAt,
      });
      if (!overlay.ok) return { ok: false, code: overlay.code, error: overlay.error };

      return {
        ok: true,
        status,
        turnRunId: input.turnRunId,
        objectId: seg.objectId,
        ...(checkpointPointer !== undefined ? { checkpointPointer } : {}),
      };
    },
  };
}
