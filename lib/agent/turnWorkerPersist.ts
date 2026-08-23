/**
 * backend-agents B7 — worker Blob persist seam: append-only transcript segment.
 *
 * `persistTranscriptSegment` is the **server-side** persist step for a turn
 * segment (the worker `"use step"` surface owns wiring this into the workflow in
 * B13; this module is the pure, testable persist helper). It:
 *
 *  1. Mints a NEW session-bound object id (`newBlobObjectId(scope)`) — the id IS
 *     the Blob pathname AND the Redis envelope `meta.transcriptPointer`.
 *  2. **Server-side** writes the segment through the `BlobTranscriptStore` seam's
 *     new `writeSegment` surface (the segment body rides in Blob, never the 1 MiB
 *     envelope `meta` body).
 *  3. Append-only: each segment is a NEW object; an earlier object is never
 *     rewritten (the store fails closed on an overwrite).
 *  4. Advances `meta.transcriptPointer` **only on a successful PUT** (fail-closed):
 *     reads the current envelope, sets the pointer, and upserts with an `updatedAt`
 *     not lower than the stored envelope's (LWW). A failed/missing write NEVER
 *     advances the pointer and never writes a partial envelope.
 *
 * Layer: server-side `lib/*` only — no DOM, no Wasm, no Vercel route. It reaches
 * `lib/sessions/*` exclusively through injected seams (the `BlobTranscriptStore`
 * and the envelope store), and **constructs no I/O in its own body** (di-gate).
 * Binding is session-scoped via `ObjectScope` and re-verified with
 * `isObjectIdBoundTo` so an object minted for one `{tenant,user,session}` can
 * never be written/pointed under a foreign scope.
 *
 * External implementations of `BlobTranscriptStore` and the envelope store are
 * intended for tests (in-memory doubles), mirroring the rest of the seam.
 */
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
} from '../sessionCloudCaps';
import {
  type BlobTranscriptStore,
  type ObjectScope,
  newBlobObjectId,
  isObjectIdBoundTo,
  isTranscriptObjectId,
} from '../sessions/blobStore';
import {
  type ServerSessionStore,
  isEnvelopeStore,
  type SessionRecordKey,
  type SessionEnvelopeInput,
} from '../sessions/sessionStore';

/** A turn segment to persist — an append-only transcript body. */
export type TranscriptSegment = {
  /** The segment body (JSON/delta/seed). Never a secret. */
  content: string;
  contentType?: string;
};

export type PersistTranscriptSegmentInput = {
  store: BlobTranscriptStore;
  envelopeStore: ServerSessionStore;
  scope: ObjectScope;
  segment: TranscriptSegment;
};

export type PersistTranscriptSegmentResult =
  | { ok: true; objectId: string }
  | {
      ok: false;
      code:
        | 'not_envelope_store'
        | 'invalid_scope'
        | 'write_failed'
        | 'pointer_write_failed';
      error: string;
    };

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Mints + server-writes ONE new session-bound transcript segment and advances
 * `meta.transcriptPointer` only on a successful PUT (fail-closed, LWW). Never
 * throws: every failure path returns `{ ok: false }` with the pointer untouched.
 */
export async function persistTranscriptSegment(
  input: PersistTranscriptSegmentInput,
): Promise<PersistTranscriptSegmentResult> {
  if (!input?.envelopeStore) {
    return {
      ok: false,
      code: 'not_envelope_store',
      error: 'persistTranscriptSegment requires an envelope store.',
    };
  }
  if (!isEnvelopeStore(input.envelopeStore)) {
    return {
      ok: false,
      code: 'not_envelope_store',
      error:
        'envelope store must implement the phase-0 envelope seam (readEnvelope/upsertEnvelope).',
    };
  }
  const { tenantId, userId, sessionId } = input.scope ?? {};
  if (
    typeof tenantId !== 'string' ||
    typeof userId !== 'string' ||
    typeof sessionId !== 'string'
  ) {
    return { ok: false, code: 'invalid_scope', error: 'persistTranscriptSegment requires a session scope.' };
  }
  if (!input.segment || typeof input.segment.content !== 'string') {
    return { ok: false, code: 'write_failed', error: 'persistTranscriptSegment requires a segment content string.' };
  }

  // 1. Mint a NEW session-bound object id (id IS the Blob pathname AND the pointer).
  const objectId = newBlobObjectId(input.scope);
  if (!isTranscriptObjectId(objectId) || !isObjectIdBoundTo(objectId, input.scope)) {
    return {
      ok: false,
      code: 'invalid_scope',
      error: 'minted transcript object id is not bound to the session scope.',
    };
  }

  // 2. Server-side write via the seam's write surface (fail-closed on error).
  try {
    await input.store.writeSegment({
      objectId,
      content: input.segment.content,
      contentType: input.segment.contentType,
      maxBytes: HARNESS_SESSION_MAX_BODY_BYTES,
    });
  } catch (err) {
    return { ok: false, code: 'write_failed', error: `transcript segment write failed: ${toMessage(err)}` };
  }

  // 3. Advance `meta.transcriptPointer` only on a successful PUT (fail-closed, LWW).
  const key: SessionRecordKey = { tenantId, userId, sessionId };
  try {
    const envelope = await input.envelopeStore.readEnvelope(key);
    // Preserve the stored `updatedAt` (never bump the host clock): the store's
    // LWW rejects an `updatedAt` lower than the stored envelope's, so a stale
    // worker bookkeeping write can never regress a newer envelope.
    const updatedAt = envelope?.updatedAt ?? Date.now();
    const inputEnvelope: SessionEnvelopeInput = {
      id: sessionId,
      userId,
      tenantId,
      updatedAt,
      // Copy-forward then override: store replaces whole meta (omit = clear).
      meta: { ...(envelope?.meta ?? {}), transcriptPointer: objectId },
    };
    const upsert = await input.envelopeStore.upsertEnvelope(key, inputEnvelope);
    if (upsert.status !== 'stored') {
      return {
        ok: false,
        code: 'pointer_write_failed',
        error: 'envelope upsert conflicted on LWW (did not advance transcriptPointer).',
      };
    }
    return { ok: true, objectId };
  } catch (err) {
    return {
      ok: false,
      code: 'pointer_write_failed',
      error: `failed to advance meta.transcriptPointer: ${toMessage(err)}`,
    };
  }
}
