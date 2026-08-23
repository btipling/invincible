/**
 * backend-agents E (#791 / source #768) — WORKER persist seam helper for the turn
 * workflow. Additive, pure (DI-injected — never reads `process.env`), server-only.
 *
 * The durable surface of a Workflow turn is written here, from the WORKER
 * (parent #764 decision "Workflow writes Blob incrementally; host PUTs are a
 * cache when attached (LWW)"):
 *
 *   1. `persistTranscriptSegment` — mint a scoped Blob object, PUT an
 *      append-only transcript segment, then advance `meta.transcriptPointer` to
 *      the new object id via `upsertEnvelope` (LWW on `updatedAt`). Fail closed:
 *      if the PUT fails the pointer is NEVER advanced, so the envelope can never
 *      point at a missing/empty object (same discipline as the host's
 *      `putTranscriptObject`, reader's Minor L1).
 *
 *   2. `persistEnvelopeMeta` — PATCH-like upsert of the reserved `meta` keys the
 *      worker owns (`logicalCwd`, `activeSandboxId`, `usage`, `attachedSkills`,
 *      `turnRunId`, `turnStatus`). Per the reserved-meta write contract
 *      (`RESERVED_META_KEYS`, `lib/sessions/sessionStore.ts`): PUT meta REPLACES,
 *      absent key = clear, so a mid-turn writer MUST copy the existing meta and
 *      override only the key it means to change — otherwise a worker PUT would
 *      WIPE the surface the host/other slices wrote. This helper overlays the
 *      caller's patch onto the existing envelope meta.
 *
 *   3. `persistMessageCheckpoint` — the durable model context = truncated
 *      `response.messages` (aligned #549) is stored as its OWN Blob object (the
 *      8 MiB object ceiling), NEVER in the envelope `meta` (that wire is the
 *      1 MiB whole-meta budget `HARNESS_SESSION_MAX_META_BYTES` shared by every
 *      reserved key — plan-review Major carrier fix).
 *
 * Never writes secrets/BYOK/DEK into Blob or envelope — the worker resolves them
 * in the step process and they stay out of persisted state.
 */

import { encodeUsageMetaString } from './usageSummary';
import { HARNESS_SESSION_MAX_BODY_BYTES } from '../sessionCloudCaps';
import type {
  BlobTranscriptStore,
  ObjectScope,
  TranscriptObjectId,
} from '../sessions/blobStore';
import type {
  HarnessSessionMeta,
  SessionEnvelopeStore,
  SessionRecordKey,
} from '../sessions/sessionStore';
import type { UsageSummary } from './usageSummary';

/** JSON content-type for transcript segments / checkpoints. */
const SEGMENT_CONTENT_TYPE = 'application/json';

/** Injected object-PUT (default: fetch to the minted URL). */
export type PutObject = (uploadUrl: string, body: unknown) => Promise<boolean>;

async function defaultPutObject(uploadUrl: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: { 'content-type': SEGMENT_CONTENT_TYPE },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Result of a worker persist write. */
export type TurnWorkerPersistResult =
  | { ok: true; objectId?: TranscriptObjectId; envelope?: import('../sessions/sessionStore').SessionEnvelope }
  | { ok: false; code: string; message: string };

/**
 * Worker meta patch — the fields the worker writes. `usage` is accepted as the
 * bounded provider-usage summary (encoded to the reserved-meta string here);
 * `attachedSkills` as a full JSON-encoded slug list (`'["slug",…]'` — the exact
 * reserved-meta string format the envelope validator requires, NOT a raw array).
 */
export type TurnWorkerMetaPatch = {
  logicalCwd?: string;
  activeSandboxId?: string;
  usage?: UsageSummary;
  /** JSON-encoded slug array string (`'["a","b"]'`) or already-undefined. */
  attachedSkills?: string;
  turnRunId?: string;
  turnStatus?: string;
  /**
   * Reserved-meta keys to CLEAR (delete) on this patch — the worker calls the
   * envelope's "absent key = clear" contract to release the single-run lock on
   * completion (`turnRunId`/`turnStatus`, adversary Major #2). A key listed
   * here is removed from the meta (and takes precedence over any set value).
   */
  clearKeys?: Array<keyof HarnessSessionMeta>;
};

/** No-op when every patch field is undefined AND no key is cleared. */
function isNoopPatch(patch: TurnWorkerMetaPatch | undefined): boolean {
  if (!patch) return true;
  if (patch.clearKeys && patch.clearKeys.length > 0) return false;
  return !Object.values(patch).some((v) => v !== undefined && !Array.isArray(v));
}

/** Overlay the caller's worker meta patch onto an existing envelope's meta. */
function overlayWorkerMeta(
  existingMeta: HarnessSessionMeta | undefined,
  patch: TurnWorkerMetaPatch | undefined,
): HarnessSessionMeta {
  const meta: HarnessSessionMeta = { ...(existingMeta ?? {}) };
  if (!patch) return meta;
  // Clear-first (absent key = clear); a key in clearKeys wins over any set value.
  if (patch.clearKeys && patch.clearKeys.length > 0) {
    for (const k of patch.clearKeys) delete meta[k];
  }
  if (patch.logicalCwd !== undefined) meta.logicalCwd = patch.logicalCwd;
  if (patch.activeSandboxId !== undefined) meta.activeSandboxId = patch.activeSandboxId;
  if (patch.usage !== undefined) {
    const encoded = encodeUsageMetaString(patch.usage);
    if (encoded !== undefined) meta.usage = encoded;
  }
  if (patch.attachedSkills !== undefined) meta.attachedSkills = patch.attachedSkills;
  if (patch.turnRunId !== undefined) meta.turnRunId = patch.turnRunId;
  if (patch.turnStatus !== undefined) meta.turnStatus = patch.turnStatus;
  return meta;
}

/** A worker persist seam bound to a blob store + envelope store + PUT impl. */
export type TurnWorkerPersistSeam = {
  blobStore: BlobTranscriptStore;
  envelopeStore: SessionEnvelopeStore;
  putObject?: PutObject;
};

function parts(key: SessionRecordKey) {
  return { tenantId: key.tenantId, userId: key.userId, sessionId: key.sessionId };
}

/** Build an ownership scope from a session key (object binding derives from it). */
function scopeFor(key: SessionRecordKey): ObjectScope {
  return { tenantId: key.tenantId, userId: key.userId, sessionId: key.sessionId };
}

export function createTurnWorkerPersist(
  deps: TurnWorkerPersistSeam,
): {
  persistTranscriptSegment(
    key: SessionRecordKey,
    opts: {
      segment: unknown;
      updatedAt: number;
      metaPatch?: TurnWorkerMetaPatch;
    },
  ): Promise<TurnWorkerPersistResult>;
  persistEnvelopeMeta(
    key: SessionRecordKey,
    opts: {
      updatedAt: number;
      patch: TurnWorkerMetaPatch;
    },
  ): Promise<TurnWorkerPersistResult>;
  persistMessageCheckpoint(
    key: SessionRecordKey,
    opts: { checkpoint: unknown; updatedAt: number },
  ): Promise<TurnWorkerPersistResult>;
} {
  const putObject = deps.putObject ?? defaultPutObject;

  /**
   * Upsert the envelope, overlaying the caller's worker meta patch onto the
   * EXISTING meta (reserved-meta write contract: copy then override; absent key
   * on the underlying upsert = clear only the caller's ownsable prefix fields,
   * never all other reserved keys). LWW on `updatedAt` is enforced by the store.
   */
  async function upsertEnvelopeWithMeta(
    key: SessionRecordKey,
    updatedAt: number,
    patch: TurnWorkerMetaPatch | undefined,
    pointer: TranscriptObjectId | undefined,
  ): Promise<TurnWorkerPersistResult> {
    try {
      const existing =
        pointer !== undefined || !isNoopPatch(patch)
          ? await deps.envelopeStore.readEnvelope(key)
          : null;
      let meta = overlayWorkerMeta(existing?.meta, patch);
      if (pointer !== undefined) meta = { ...meta, transcriptPointer: pointer };
      // The identity guard is enforced by the store (throws on mismatch); we
      // still pass the full ownership triplet so bind never drifts.
      const res = await deps.envelopeStore.upsertEnvelope(key, {
        id: key.sessionId,
        tenantId: key.tenantId,
        userId: key.userId,
        updatedAt,
        meta,
      });
      if (res.status === 'conflict') {
        return {
          ok: false,
          code: 'ENVELOPE_CONFLICT',
          message: 'Envelope conflict: a newer write won (LWW).',
        };
      }
      return { ok: true, envelope: res.envelope };
    } catch (err) {
      return {
        ok: false,
        code: 'ENVELOPE_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    /**
     * Append a transcript segment: mint a scoped Blob object, PUT the segment,
     * then (only on a successful upload) advance `meta.transcriptPointer` and
     * overlay the worker meta patch in the same upsert.
     */
    async persistTranscriptSegment(key, opts: {
      segment: unknown;
      updatedAt: number;
      metaPatch?: TurnWorkerMetaPatch;
    }) {
      const scope = scopeFor(key);
      let minted;
      try {
        minted = await deps.blobStore.mintUpload({
          scope,
          contentType: SEGMENT_CONTENT_TYPE,
          maxBytes: HARNESS_SESSION_MAX_BODY_BYTES,
        });
      } catch (err) {
        return {
          ok: false,
          code: 'BLOB_MINT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const uploaded = await putObject(minted.uploadUrl, opts.segment);
      // Fail closed on the one write that matters: never advance the pointer to a
      // missing/empty object (reader's Minor L1 parity).
      if (!uploaded) {
        return {
          ok: false,
          code: 'BLOB_PUT_FAILED',
          message: 'Transcript segment upload failed; envelope pointer not advanced.',
        };
      }
      const metaRes = await upsertEnvelopeWithMeta(
        key,
        opts.updatedAt,
        opts.metaPatch,
        minted.objectId,
      );
      if (!metaRes.ok) return metaRes;
      return { ok: true, objectId: minted.objectId, envelope: metaRes.envelope };
    },

    /** PATCH-like upsert of the worker-owned envelope meta (LWW). */
    async persistEnvelopeMeta(key, opts: {
      updatedAt: number;
      patch: TurnWorkerMetaPatch;
    }) {
      if (isNoopPatch(opts.patch)) {
        return { ok: true };
      }
      return upsertEnvelopeWithMeta(key, opts.updatedAt, opts.patch, undefined);
    },

    /**
     * Persist the durable model context (truncated `response.messages`) as its
     * OWN Blob object (8 MiB object ceiling). NEVER rides the envelope `meta`
     * (1 MiB whole-meta budget) — the envelope carries only the small
     * `transcriptPointer`/`turnRunId`/`turnStatus` scalars. The object id is
     * returned so the orchestrator can record it if the plan later tracks it.
     */
    async persistMessageCheckpoint(key, opts: {
      checkpoint: unknown;
      updatedAt: number;
    }) {
      // Ownership scope binds the checkpoint object to this session so a
      // foreign/planted pointer can never be signed (reader's Major L2).
      const scope = scopeFor(key);
      let minted;
      try {
        minted = await deps.blobStore.mintUpload({
          scope,
          contentType: SEGMENT_CONTENT_TYPE,
          maxBytes: HARNESS_SESSION_MAX_BODY_BYTES,
        });
      } catch (err) {
        return {
          ok: false,
          code: 'BLOB_MINT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const uploaded = await putObject(minted.uploadUrl, opts.checkpoint);
      if (!uploaded) {
        return {
          ok: false,
          code: 'BLOB_PUT_FAILED',
          message: 'Message checkpoint upload failed.',
        };
      }
      // By design this does NOT touch the envelope meta — the checkpoint object
      // is addressed by its returned id, never by a reserved-meta key.
      return { ok: true, objectId: minted.objectId };
    },
  };
}
