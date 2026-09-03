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
  HARNESS_SESSION_MAX_BODY_BYTES,
  TURN_MSG_CHECKPOINT_MAX_BYTES,
  TRANSCRIPT_CHUNK_WALK_MAX,
} from '../sessionCloudCaps';
import { fitSnapshotUtf8 } from './fitSnapshotUtf8';
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
  mergeCheckpointOntoPrior,
  truncateMessageCheckpoint,
  snapshotMessagesFromUnknown,
  type CheckpointSnapshotMessage,
} from './messageCheckpoint';
import { persistTranscriptSegment } from './turnWorkerPersist';
import {
  reconstructTranscriptChain,
  transcriptChunkChainLength,
  transcriptChunkPrev,
} from '../sessions/transcriptChunks';
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
import { queueTextFromUserContent, queueWithoutText, sanitizeQueue } from '../turnQueue';

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

/** F21 queue mirror on a snapshot-shaped body; undefined = no/poisoned carrier. */
function queueFromBody(body: unknown): string[] | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return sanitizeQueue((body as Record<string, unknown>).queue);
}

/** First non-blank this-run user prompt (unwraps a history-fold userMessage). */
function firstUserText(
  messages: Array<{ role: string; text: string }>,
): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const t = queueTextFromUserContent(m.text);
    if (t) return t;
  }
  return undefined;
}

/** This-run snapshot + optional `prev`/`depth`; non-snapshot test bodies keep stamp-only.
 *  `mergePrior` (plan #934): when set (TERMINAL persists only), this-run messages are
 *  suffix-merged onto the prior readable transcript so the head chunk carries the
 *  full this-run + prior history — a wall-clock `error` terminal is then as durable
 *  as a `done` terminal, with no host flatten required (idempotent: a prior that
 *  already covers this-run — host flatten or a persist retry — stays unchanged).
 *  Terminal merged heads omit `prev`/`depth` (flatten root) so GET never walks
 *  ancestors (adversarial #935: walk-fail fail-soft of a thin completed overlay
 *  clobbers local P0). Mid-turn `running` chunks still link `prev`. */
function buildThisRunChunk(opts: {
  content: string;
  sessionId: string;
  updatedAt: number;
  prev: string | undefined;
  depth: number | undefined;
  /** Prior blob's sanitized `queue` (copy-forward when this-run content omits it). */
  priorQueue?: string[];
  /** Prior transcript messages to suffix-merge onto (terminal persist only). */
  mergePrior?: ReadonlyArray<CheckpointSnapshotMessage>;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const incoming = snapshotMessagesFromUnknown(parsed, opts.sessionId);
  if (incoming === null) {
    return stampSnapshotUpdatedAt(opts.content, opts.updatedAt);
  }
  const merged =
    opts.mergePrior !== undefined
      ? mergeCheckpointOntoPrior(opts.mergePrior, incoming)
      : incoming;
  const rec: Record<string, unknown> = {
    id: opts.sessionId,
    updatedAt: opts.updatedAt,
    messages: merged,
  };
  if (opts.prev) rec.prev = opts.prev;
  if (opts.depth !== undefined) rec.depth = opts.depth;
  // F21 adversarial #901: worker this-run chunks must copy-forward the
  // submit-queue mirror (field rides the transcript blob, not meta). Dropping
  // it lets a cloud adopt wipe a localStorage re-arm. Copy-forward of the
  // *in-flight* prompt (HEAD Major): persistStep content is `{id, messages}`
  // so fromContent is always unset; a coalesced host strip PUT cannot beat
  // B7. Strip this-run's user prompt (removeQueuedText semantics) so a drain
  // that has durably started cannot re-arm itself on F5. Production
  // userMessage is a formatPromptWithHistory fold, not the raw queue item —
  // queueTextFromUserContent unwraps the last `User:` line.
  const fromContent = queueFromBody(parsed);
  let queue = fromContent ?? opts.priorQueue;
  const started = firstUserText(incoming);
  if (started) queue = queueWithoutText(queue, started);
  if (queue !== undefined && queue.length > 0) rec.queue = queue;
  return JSON.stringify(rec);
}

/**
 * Build the real B7/B8/B6 persist seam for one session scope. The caller (C14
 * engine route / composition root) constructs this per session and installs it
 * via `setPersistSeamResolver` before `start(runTurnWorkflow, …)`.
 *
 * Business errors are **values**: every failure path returns `{ ok:false, code,
 * error }` (B7/B8 codes surfaced verbatim). Persist `{ok:false}` of any code
 * does not fail the turn. Never throws.
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
      if (input.fold?.resolvedProvider !== undefined) {
        patch.resolvedProvider = input.fold.resolvedProvider;
      }

      let stored: SessionEnvelope | null = null;
      let envelopeReadError: string | null = null;
      if (envelope) {
        try {
          stored = await envelope.readEnvelope(key);
        } catch (err) {
          envelopeReadError = `envelope read failed: ${toMessage(err)}`;
        }
      }
      const updatedAt = clock(stored?.updatedAt ?? 0);

      const failWrite = async (result: {
        ok: false;
        code: string;
        error: string;
      }): Promise<PersistStepResult> => {
        if (status === 'completed') {
          await overlayWorkerMeta({
            envelopeStore,
            key,
            patch,
            updatedAt,
          });
        }
        return result;
      };

      if (envelopeReadError !== null) {
        return await failWrite({
          ok: false,
          code: 'write_failed',
          error: envelopeReadError,
        });
      }

      // Worker chunks (plan #886): this-run messages + `prev` pointing at the
      // current bound pointer. Head-only link check (adversarial #889): a full
      // ancestor walk cannot LWW-clobber (this-run + prev=pointer never replaces
      // history) and `walked.messages` was unused. Leftover `{ deltas }` is not
      // a snapshot — this-run only, no prev. Foreign/invalid `prev` **on the
      // head** still fail-closed (confused-deputy / corrupt link). `depth` on
      // the head is the chain length so persist refuses a 257th object without
      // walking (reconstruct fail-closes the whole blob at 256).
      let chunkPrev: string | undefined;
      let chunkDepth: number | undefined;
      let priorQueue: string[] | undefined;
      // Plan #934: prior readable messages captured at the gate. On the
      // TERMINAL persist these are suffix-merged under this-run (below) so the
      // head chunk is the full transcript — durability no longer depends on
      // the host `done` flatten, which a wall-clock `error` terminal skips.
      // Mid-turn `running` chunks stay this-run-only (transient overlays).
      let priorMessages: CheckpointSnapshotMessage[] | undefined;
      let priorBody: unknown | undefined;
      let priorHeadId: string | undefined;
      const pointer = stored?.meta?.transcriptPointer;
      if (typeof pointer === 'string' && isObjectIdBoundTo(pointer, scope)) {
        let raw: string | null;
        try {
          raw = await blobStore.read(pointer);
        } catch (err) {
          return await failWrite({
            ok: false,
            code: 'write_failed',
            error: `bound transcriptPointer read failed: ${toMessage(err)}`,
          });
        }
        if (raw === null) {
          return await failWrite({
            ok: false,
            code: 'write_failed',
            error:
              'bound transcriptPointer object is missing — refusing this-run-only replace.',
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return await failWrite({
            ok: false,
            code: 'write_failed',
            error:
              'bound transcriptPointer body is not JSON — refusing this-run-only replace.',
          });
        }
        if (snapshotMessagesFromUnknown(parsed, scope.sessionId) !== null) {
          const prev = transcriptChunkPrev(parsed);
          if (prev.kind === 'invalid') {
            return await failWrite({
              ok: false,
              code: 'write_failed',
              error: 'transcript chunk prev is not a Redis-safe object id.',
            });
          }
          if (prev.kind === 'id' && !isObjectIdBoundTo(prev.id, scope)) {
            return await failWrite({
              ok: false,
              code: 'write_failed',
              error: 'transcript chunk prev is not bound to this session.',
            });
          }
          const chainLen = transcriptChunkChainLength(parsed);
          if (chainLen >= TRANSCRIPT_CHUNK_WALK_MAX) {
            return await failWrite({
              ok: false,
              code: 'write_failed',
              error: `transcript chunk chain length ${chainLen} is at walk cap ${TRANSCRIPT_CHUNK_WALK_MAX} — refusing append.`,
            });
          }
          chunkPrev = pointer;
          chunkDepth = chainLen + 1;
          priorQueue = queueFromBody(parsed);
          priorMessages = snapshotMessagesFromUnknown(parsed, scope.sessionId) ?? undefined;
          priorBody = parsed;
          priorHeadId = pointer;
        }
      }

      // Plan #934 — terminal persist suffix-merges this-run onto the
      // reconstructed prior chain (source #933). The bound pointer after a
      // mid-turn `running` persist is a this-run-only overlay; merging onto
      // that body alone leaves the head thin. Reconstruct (injected blob
      // reads, same walk as GET) materializes prior + overlay so the head
      // itself is the full transcript. Flatten-root priors (no `prev`) are
      // already complete; reconstruct is a no-walk. A broken chain fail-closes
      // rather than publishing a thin head as durable.
      if (
        status === 'completed' &&
        priorMessages !== undefined &&
        priorBody !== undefined &&
        priorHeadId
      ) {
        const walked = await reconstructTranscriptChain({
          sessionId: scope.sessionId,
          headId: priorHeadId,
          headBody: priorBody,
          read: async (objectId) => {
            try {
              const b = await blobStore.read(objectId);
              if (b === null) return null;
              try {
                return JSON.parse(b);
              } catch {
                return null;
              }
            } catch {
              return null;
            }
          },
          isBound: (oid) => isObjectIdBoundTo(oid, scope),
        });
        if (!walked.ok) {
          return await failWrite({
            ok: false,
            code: 'write_failed',
            error: `terminal merge reconstruct failed: ${walked.error}`,
          });
        }
        priorMessages = walked.messages;
      }

      // Plan #934 — terminal persist suffix-merges this-run onto the prior
      // transcript (source #933): on a wall-capped turn the SSE terminal is
      // `error`, so the host never runs its `done` flatten and a this-run-only
      // head would strand this-turn assistants. The merge reuses the shipped,
      // idempotent `mergeCheckpointOntoPrior` (the same primitive
      // `reconstructTranscriptChain` uses on read): a prior that already
      // covers this-run (host-flattened `done` path, mid-turn worker chunk
      // being retried) stays byte-equal — no duplicate rows. Mid-turn
      // `running` persists keep the thin this-run chunk (transient overlay).
      //
      // Adversarial #935: the merged terminal head is a flatten root
      // (`prev`/`depth` omitted). GET of a self-contained head must not walk
      // ancestors — walk-fail fail-soft of a `failWrite` completed overlay
      // (pointer still this-run-only) would replace local P0 with this-run.
      const terminalFlatten = status === 'completed';
      const stampedRaw = buildThisRunChunk({
        content: input.content,
        sessionId: scope.sessionId,
        updatedAt,
        prev: terminalFlatten ? undefined : chunkPrev,
        depth: terminalFlatten ? undefined : chunkDepth,
        priorQueue,
        ...(terminalFlatten && priorMessages !== undefined
          ? { mergePrior: priorMessages }
          : {}),
      });
      if (stampedRaw === null) {
        return await failWrite({
          ok: false,
          code: 'write_failed',
          error: 'persist content is not a JSON object — cannot stamp updatedAt.',
        });
      }
      const stamped = fitSnapshotUtf8(stampedRaw, HARNESS_SESSION_MAX_BODY_BYTES);

      // Checkpoint (B6): write the bounded `{role,content}` projection as its
      // OWN Blob object; only the object id rides in meta. Runs AFTER the
      // prior-read gate so a bound-pointer miss does not orphan a checkpoint.
      let checkpointPointer: string | undefined;
      if (input.fold?.checkpoint !== undefined) {
        const bounded = truncateMessageCheckpoint(input.fold.checkpoint);
        const ckptObjectId = newBlobObjectId(scope);
        if (!isObjectIdBoundTo(ckptObjectId, scope)) {
          return await failWrite({
            ok: false,
            code: 'checkpoint_write_failed',
            error: 'minted checkpoint object id is not bound to the session scope.',
          });
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
          return await failWrite({
            ok: false,
            code: 'checkpoint_write_failed',
            error: `checkpoint blob write failed: ${toMessage(err)}`,
          });
        }
      }

      // Transcript (B7): write this-run chunk + advance transcriptPointer
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
      if (!seg.ok) {
        return await failWrite({ ok: false, code: seg.code, error: seg.error });
      }

      const overlay = await overlayWorkerMeta({
        envelopeStore,
        key,
        patch,
        updatedAt,
      });
      if (!overlay.ok) {
        // B7 already committed the pointer. Retry overlay so a one-shot Redis
        // blip on B8's read still writes `completed` (failWrite) instead of
        // leaving `running` for F5 attach.
        return await failWrite({
          ok: false,
          code: overlay.code,
          error: overlay.error,
        });
      }

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
