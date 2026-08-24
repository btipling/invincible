/**
 * backend-agents B13 (#807) — the REAL worker persist seam (`createTurnPersistSeam`):
 * composes B7 (`persistTranscriptSegment` → `transcriptPointer`), B8
 * (`overlayWorkerMeta` → terminal worker keys), and B6 (`truncateMessageCheckpoint`
 * → own Blob object, pointer only in `meta`). In-memory blob + envelope doubles;
 * no live Blob / Redis. Covers the plan's 8-row testing matrix.
 */
import { describe, it, expect } from 'vitest';
import {
  type BlobTranscriptStore,
  type ObjectScope,
  newBlobObjectId,
} from '../sessions/blobStore';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type {
  ServerSessionStore,
  SessionRecordKey,
} from '../sessions/sessionStore';
import { createTurnPersistSeam } from './turnPersistSeam';
import type { PersistStepSeam } from '../workflows/persistStep';
import { reachableImports } from '../workflows/staticGraph';

const scope: ObjectScope = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};
const key: SessionRecordKey = scope;

/** A store that throws on write — simulates a failed server-side PUT (matrix 6). */
class ThrowingBlobStore extends MemoryBlobTranscriptStore {
  override async writeSegment(): Promise<void> {
    throw new Error('PUT failed (non-2xx)');
  }
}

async function makeSeam(
  opts: {
    blobStore?: BlobTranscriptStore;
    overlayClock?: (stored: number) => number;
    seed?: { updatedAt: number; meta: Record<string, unknown> };
  } = {},
): Promise<{
  seam: PersistStepSeam;
  blobStore: BlobTranscriptStore;
  envelopeStore: MemorySessionStore;
}> {
  const blobStore = opts.blobStore ?? new MemoryBlobTranscriptStore();
  const envelopeStore = new MemorySessionStore();
  if (opts.seed) {
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: opts.seed.updatedAt,
      meta: opts.seed.meta,
    });
  }
  const seam = createTurnPersistSeam({
    blobStore,
    envelopeStore,
    scope,
    ...(opts.overlayClock ? { overlayClock: opts.overlayClock } : {}),
  });
  return { seam, blobStore, envelopeStore };
}

const realRunId = 'wr_0000_1f2e3d4c5b6a';
const fold = {
  cwd: 'docs',
  activeSandboxId: 'sb_123abcDEF',
  usage: { source: 'provider', total: 10 } as const,
  checkpoint: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ],
};

describe('createTurnPersistSeam — real B7/B8/B6 persist (backend-agents B13)', () => {
  it('matrix 2 — terminal turnStatus=completed after a successful persist', async () => {
    const { seam, envelopeStore } = await makeSeam();
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [{ d: 1 }],
      content: '{"delta":"x"}',
    });
    expect(res.ok).toBe(true);
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.turnRunId).toBe(realRunId);
  });

  it('matrix 3 — checkpoint pointer stored; body never in meta; transcriptPointer advanced by B7', async () => {
    const { seam, blobStore, envelopeStore } = await makeSeam();
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [{ d: 1 }],
      content: '{"delta":"x"}',
      fold,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkpointPointer).toBeDefined();
    const env = await envelopeStore.readEnvelope(key);
    // envelope holds BOTH the checkpoint pointer and (from B7) the transcript pointer
    expect(env?.meta?.checkpointPointer).toBe(res.checkpointPointer);
    expect(env?.meta?.transcriptPointer).toBe(res.objectId);
    // the checkpoint BODY is its own Blob object — never a meta key, never meta bloat
    const ckptBody = res.checkpointPointer
      ? await blobStore.read(res.checkpointPointer)
      : null;
    expect(JSON.parse(ckptBody ?? 'null')).toEqual(fold.checkpoint);
    expect(Object.keys(env?.meta ?? {})).not.toContain('checkpointBody');
    expect(Object.keys(env?.meta ?? {})).not.toContain('checkpointFile');
  });

  it('matrix 5 — cwd/usage/activeSandboxId folded from the final-state fold; host keys preserved byte-for-byte (B8 copy-forward)', async () => {
    const { seam, envelopeStore } = await makeSeam({
      seed: {
        updatedAt: 1000,
        meta: {
          personaId: 'p_1',
          selectedModel: 'harness-default',
          transcriptPointer: 't_old_ptr_0000',
        },
      },
    });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [{ d: 1 }],
      content: '{"delta":"x"}',
      fold,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.logicalCwd).toBe(fold.cwd);
    expect(env?.meta?.activeSandboxId).toBe(fold.activeSandboxId);
    // usage is stored in its encoded reserved-meta JSON-string form (B8)
    expect(typeof env?.meta?.usage).toBe('string');
    expect(JSON.parse(env?.meta?.usage as string)).toEqual(fold.usage);
    // host keys + the B7 advance survive byte-for-byte
    expect(env?.meta?.personaId).toBe('p_1');
    expect(env?.meta?.selectedModel).toBe('harness-default');
    expect(env?.meta?.transcriptPointer).toBe(res.objectId);
  });

  it('matrix 1 — seam passes the real run.runId through; a sessionId-shaped value is SKIPPED (B8), terminal keys still applied', async () => {
    const { seam, envelopeStore } = await makeSeam();
    // First persist with the real run id.
    const first = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{}' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.turnRunId).toBe(realRunId);

    // Second persist attempts to write the session id onto the run-id carrier.
    const second = await seam.persist({
      turnRunId: scope.sessionId,
      deltas: [],
      content: '{}',
      fold: { checkpoint: [{ role: 'assistant', content: 'again' }] },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    env = await envelopeStore.readEnvelope(key);
    // sessionId-shaped value does NOT clobber the real run id, never goes live-less
    expect(env?.meta?.turnRunId).toBe(realRunId);
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.checkpointPointer).toBe(second.checkpointPointer);
  });

  it('matrix 4 — second prompt on the same session is allowed after completion (terminal state + real run id, no live-less lock)', async () => {
    const { seam, envelopeStore } = await makeSeam();
    const first = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{}', fold });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const env = await envelopeStore.readEnvelope(key);
    // The envelope reflects a completed terminal state with a real run id — the
    // precondition a later C15 live-lock keys off: no running/turnRunId==sessionId.
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.turnRunId).not.toBe(scope.sessionId);
    // A second prompt persist is ACCEPTED (no spurious reject from a live-less id).
    const second = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{"again":1}' });
    expect(second.ok).toBe(true);
  });

  it('matrix 6 — B7 fail-closed: segment write fails → {ok:false}, pointer NOT advanced, no partial envelope', async () => {
    const { seam, envelopeStore } = await makeSeam({ blobStore: new ThrowingBlobStore() });
    const res = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{"delta":"x"}' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope(key);
    expect(env).toBeNull(); // pointer never advanced; nothing written
  });

  it('matrix 6b — checkpoint write fails → {ok:false, code:checkpoint_write_failed}; terminal meta not written', async () => {
    const { seam, envelopeStore } = await makeSeam({ blobStore: new ThrowingBlobStore() });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: '{"delta":"x"}',
      fold: { checkpoint: [{ role: 'assistant', content: 'hi' }] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('checkpoint_write_failed');
    const env = await envelopeStore.readEnvelope(key);
    expect(env).toBeNull();
  });

  it('matrix 7 — B8 LWW conflict (stale/equal injected clock) surfaces as {ok:false, code:lww_conflict}, no partial terminal write', async () => {
    const { seam, envelopeStore } = await makeSeam({
      // Pre-seed a NEWER envelope; the injected overlay clock is stale/equal → B8 conflicts.
      overlayClock: () => 1000,
      seed: { updatedAt: 2000, meta: { transcriptPointer: 't_old_ptr_0000' } },
    });
    const res = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{}', fold });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('lww_conflict');
    // No partial terminal write: turnStatus/checkpoint/logicalCwd are NOT applied.
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.turnStatus).toBeUndefined();
    expect(env?.meta?.checkpointPointer).toBeUndefined();
    expect(env?.meta?.logicalCwd).toBeUndefined();
  });

  it('produces a bound, Redis-safe checkpoint pointer when a checkpoint is written', async () => {
    const { seam } = await makeSeam();
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: '{}',
      fold,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkpointPointer).toMatch(/^t_[A-Za-z0-9_-]{1,512}$/);
  });

  it('matrix 8 — the `use workflow` entry closure does NOT reach the real seam module (injected VALUE, not static import; B11 lock)', () => {
    const reachable = reachableImports('lib/workflows/turnWorkflow.ts', {
      root: process.cwd(),
    });
    // The real seam (which imports the Banned blob surface) is never a static
    // dependency of the walked entry — it is injected, so the lock stays intact.
    expect(reachable.has('lib/agent/turnPersistSeam')).toBe(false);
    expect(reachable.has('lib/sessions/blobStore')).toBe(false);
  });

  it('mints distinct transcript + checkpoint objects (append-only; checkpoint is its own Blob object)', async () => {
    const { seam, blobStore } = await makeSeam();
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: '{"delta":"x"}',
      fold,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.objectId).toBeDefined();
    expect(res.checkpointPointer).toBeDefined();
    // Distinct objects: the transcript pointer != checkpoint pointer.
    expect(res.checkpointPointer).not.toBe(res.objectId);
    // Both live in the blob store as separate objects.
    expect(await blobStore.read(res.objectId!)).toBe('{"delta":"x"}');
    expect(await blobStore.read(res.checkpointPointer!)).toContain('"assistant"');
    // The namespace is flat + bound to this session.
    expect(newBlobObjectId(scope).startsWith('t_')).toBe(true);
  });
});
