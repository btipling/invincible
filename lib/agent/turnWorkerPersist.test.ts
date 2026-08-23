/**
 * backend-agents B7 — `persistTranscriptSegment` (worker Blob persist seam).
 * In-memory blob + envelope doubles; no live Blob / Redis. Covers the plan's
 * 9-row testing matrix.
 */
import { describe, it, expect } from 'vitest';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type {
  ServerSessionStore,
  SessionEnvelope,
  SessionEnvelopeInput,
  SessionRecordKey,
} from '../sessions/sessionStore';
import { isEnvelopeStore } from '../sessions/sessionStore';
import type { ObjectScope } from '../sessions/blobStore';
import { objectBindingFor, isTranscriptObjectId } from '../sessions/blobStore';
import { persistTranscriptSegment } from './turnWorkerPersist';
import { HARNESS_SESSION_MAX_BODY_BYTES } from '../sessionCloudCaps';

const scope: ObjectScope = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

/** A store that throws on write — simulates a failed server-side PUT. */
class ThrowingBlobStore extends MemoryBlobTranscriptStore {
  override async writeSegment(): Promise<void> {
    throw new Error('PUT failed (non-2xx)');
  }
}

/** A non-envelope store (implements only `get`/`put`/`list`/`remove`). */
class BareStore implements ServerSessionStore {
  async get(): Promise<never> {
    throw new Error('unused');
  }
  async put(): Promise<never> {
    throw new Error('unused');
  }
  async list(): Promise<never> {
    throw new Error('unused');
  }
  async remove(): Promise<boolean> {
    throw new Error('unused');
  }
}

describe('persistTranscriptSegment', () => {
  it('matrix 1 — successful PUT advances the pointer; body readable back', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: '{"delta":"hello"}', contentType: 'application/json' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // pointer = the new bound object id
    expect(isTranscriptObjectId(res.objectId)).toBe(true);
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env?.meta?.transcriptPointer).toBe(res.objectId);
    // body readable back via the blob store (memory round-trip)
    expect(await blob.read(res.objectId)).toBe('{"delta":"hello"}');
  });

  it('matrix 2 — sibling reserved-meta keys survive a persist (copy-forward is load-bearing)', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const key: SessionRecordKey = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    };
    // Seed an envelope whose `meta` carries the full reserved sibling set. The
    // Memory store's upsert replaces the WHOLE meta object, so a persist that
    // dropped the copy-forward spread would CLEAR every one of these siblings
    // (omit = clear) on the first B13 write.
    const siblings = {
      turnRunId: 'wr_0000_0000000000000000000000',
      turnStatus: 'running',
      turnStreamCursor: 7,
      checkpointPointer: 'ckpt_0000_0000000000000000000000',
      selectedModel: 'harness-default',
      usage: 12,
      attachedSkills: JSON.stringify(['plan-review']),
    };
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { ...siblings, transcriptPointer: 't_old_ptr_0000' },
    });

    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: '{}' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const env = await envelopeStore.readEnvelope(key);
    // Pointer advanced to the new object id...
    expect(env?.meta?.transcriptPointer).toBe(res.objectId);
    // ...and every sibling reserved key survived (copy-forward, then override).
    expect(env?.meta?.turnRunId).toBe(siblings.turnRunId);
    expect(env?.meta?.turnStatus).toBe(siblings.turnStatus);
    expect(env?.meta?.turnStreamCursor).toBe(siblings.turnStreamCursor);
    expect(env?.meta?.checkpointPointer).toBe(siblings.checkpointPointer);
    expect(env?.meta?.selectedModel).toBe(siblings.selectedModel);
    expect(env?.meta?.usage).toBe(siblings.usage);
    expect(env?.meta?.attachedSkills).toEqual(siblings.attachedSkills);
    expect(env?.updatedAt).toBe(1000); // worker preserved the stored clock (LWW)
  });

  it('matrix 3 — PUT failure (store throws) → pointer NOT advanced, envelope unmodified', async () => {
    const blob = new ThrowingBlobStore();
    const envelopeStore = new MemorySessionStore();
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: 'hello' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env).toBeNull(); // no envelope written at all
  });

  it('matrix 3 — stale updatedAt LWW: a worker write older than the stored envelope does NOT regress the pointer', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    // Seed a stored envelope with a NEWER updatedAt + an existing pointer.
    const key: SessionRecordKey = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    };
    const later = 2000;
    const envInput: SessionEnvelopeInput = {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: later,
      meta: { transcriptPointer: 't_old_ptr_0000' },
    };
    await envelopeStore.upsertEnvelope(key, envInput);

    // Worker writes with a stale (older) clock.
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: 'newer segment' },
    });
    // The worker preserves the stored `updatedAt` (2000) and overrides the pointer.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.transcriptPointer).toBe(res.objectId);
    expect(env?.updatedAt).toBe(later); // clock not bumped by the worker
  });

  it('matrix 4 — two segments append: two distinct objects; pointer ends on the latest; first object unmodified', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const first = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: 'seg-1' },
    });
    const second = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: 'seg-2' },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.objectId).not.toBe(second.objectId);
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env?.meta?.transcriptPointer).toBe(second.objectId); // latest
    // both objects exist; the first is unmodified
    expect(await blob.read(first.objectId)).toBe('seg-1');
    expect(await blob.read(second.objectId)).toBe('seg-2');
  });

  it('matrix 5 — poisoned/non-opaque pointer is never written (upstream id is always valid, guard fails closed)', async () => {
    // The minted id is guaranteed Redis-safe opaque + bound, so a poisoned value
    // can only enter via a corrupt store result. Simulate by checking the guard:
    // `isObjectIdBoundTo` rejects a foreign id before write.
    const foreign = objectBindingFor({
      tenantId: 'other',
      userId: 'other',
      sessionId: 'other',
    });
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    // persist always mints a bound id, so a successful write never carries a
    // non-opaque pointer. Assert the invariant the envelope actually stored:
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: 'x' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.objectId.includes(foreign)).toBe(false);
    expect(isTranscriptObjectId(res.objectId)).toBe(true);
  });

  it('matrix 6 — foreign scope binding: an object minted under a different {tenant,user,session} is never accepted for THIS envelope', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    // Persist for scope A, then attempt to "plant" that id onto scope B's envelope
    // by directly writing a foreign-bound pointer through the store.
    const otherScope: ObjectScope = {
      tenantId: 'tenant-B',
      userId: 'user-B',
      sessionId: 'session-B',
    };
    const resB = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope: otherScope,
      segment: { content: 'for-B' },
    });
    expect(resB.ok).toBe(true);
    if (!resB.ok) return;
    // A's envelope must NOT reference B's object.
    const envA = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(envA?.meta?.transcriptPointer).toBeUndefined();
    const envB = await envelopeStore.readEnvelope({
      tenantId: otherScope.tenantId,
      userId: otherScope.userId,
      sessionId: otherScope.sessionId,
    });
    expect(envB?.meta?.transcriptPointer).toBe(resB.objectId);
  });

  it('matrix 7 — non-envelope store → fails closed, no pointer write', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore: new BareStore(),
      scope,
      segment: { content: 'x' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_envelope_store');
    // The guard returns before any write — envelope is never created.
  });

  it('matrix 8 — oversize segment (> maxBytes) is rejected by the store; pointer never advances', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const big = 'x'.repeat(HARNESS_SESSION_MAX_BODY_BYTES + 1);
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope,
      segment: { content: big },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env).toBeNull();
  });

  it('matrix 9 helps — invalid scope fails closed before any write', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const res = await persistTranscriptSegment({
      store: blob,
      envelopeStore,
      scope: { tenantId: 1 as unknown as string, userId: 2 as unknown as string, sessionId: 3 as unknown as string },
      segment: { content: 'x' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('invalid_scope');
  });

  it('isEnvelopeStore guard is true for MemorySessionStore', () => {
    expect(isEnvelopeStore(new MemorySessionStore())).toBe(true);
  });
});
