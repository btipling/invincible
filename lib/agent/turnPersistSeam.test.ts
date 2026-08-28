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
import { parseCloudSessionSnapshot } from '../sessionRepository';

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

/** Next `readEnvelope` rejects once when `armThrow` is set (Redis blip). */
class ThrowOnceEnvelopeStore extends MemorySessionStore {
  armThrow = false;
  override async readEnvelope(k: SessionRecordKey) {
    if (this.armThrow) {
      this.armThrow = false;
      throw new Error('redis blip');
    }
    return super.readEnvelope(k);
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

  it('matrix 7 — B8 LWW conflict (stale/equal injected clock) surfaces as {ok:false, code:lww_conflict}; terminal keys NOT applied (honest partial-commit scope)', async () => {
    const { seam, envelopeStore, blobStore } = await makeSeam({
      // Pre-seed a NEWER envelope; the injected overlay clock is stale/equal → B8 conflicts.
      overlayClock: () => 1000,
      seed: { updatedAt: 2000, meta: { transcriptPointer: 't_old_ptr_0000' } },
    });
    const res = await seam.persist({ turnRunId: realRunId, deltas: [], content: '{}', fold });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('lww_conflict');
    // NO partial TERMINAL write: turnStatus/checkpointPointer/logicalCwd are NOT applied.
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.turnStatus).toBeUndefined();
    expect(env?.meta?.checkpointPointer).toBeUndefined();
    expect(env?.meta?.logicalCwd).toBeUndefined();
    // HONEST partial-commit scope (adversarial L1): the seam composes TWO
    // envelope writes — B7 advances `meta.transcriptPointer` on its OWN upsert
    // (fail-closed) BEFORE B8's terminal overlay runs. With the injected stale
    // clock, B7's pointer write SUCCEEDS (equal clock is not < stored, so LWW
    // accepts it) and the B8 conflict does NOT roll it back. So claiming "no
    // partial write" is false: on a B8 LWW conflict the transcriptPointer IS
    // already advanced and the checkpoint blob IS written but unpointed
    // (orphaned, recoverable — the pre-existing concurrent-host LWW residual of
    // composing two already-shipped writes). The DEFAULT clock
    // (`max(now, stored+1)`) is what prevents B7→B8 from ever self-conflicting
    // on a real run. We assert the true state rather than over-claim.
    expect(env?.updatedAt).toBe(2000); // B7's pointer upsert accepted (2000 !< 2000)
    expect(env?.meta?.transcriptPointer).toBeDefined();
    expect(env?.meta?.transcriptPointer).not.toBe('t_old_ptr_0000'); // advanced past seed
    // The checkpoint blob was written (B6) BEFORE the B7 pointer write and is now
    // ORPHANED — present in the blob store but never pointed to in meta. That
    // orphan is append-only (immune to corruption) and recoverable; it is the
    // honest footprint of a B8-conflict path, not silently hidden.
    expect(env?.meta?.checkpointPointer).toBeUndefined();
    void blobStore;
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
    // Both live in the blob store as separate objects. Transcript body is the
    // stamped JSON (updatedAt overlay clock), not the raw input string.
    const transcript = JSON.parse((await blobStore.read(res.objectId!)) ?? 'null') as {
      delta?: string;
      updatedAt?: number;
    };
    expect(transcript.delta).toBe('x');
    expect(Number.isFinite(transcript.updatedAt)).toBe(true);
    expect(await blobStore.read(res.checkpointPointer!)).toContain('"assistant"');
    // The namespace is flat + bound to this session.
    expect(newBlobObjectId(scope).startsWith('t_')).toBe(true);
  });

  it('blob updatedAt equals B8 envelope clock; OverlayClock invoked once', async () => {
    let clockCalls = 0;
    const { seam, blobStore, envelopeStore } = await makeSeam({
      overlayClock: (stored) => {
        clockCalls += 1;
        return Math.max(9_000, stored + 1);
      },
      seed: { updatedAt: 1000, meta: { transcriptPointer: 't_old_ptr_0000' } },
    });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [{ d: 1 }],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [{ id: 'cp_0', role: 'user', text: 'hello', at: 1 }],
        deltas: [{ d: 1 }],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(clockCalls).toBe(1);
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.updatedAt).toBe(9_000);
    const raw = await blobStore.read(res.objectId!);
    const body = JSON.parse(raw ?? 'null') as {
      id: string;
      updatedAt: number;
      messages: unknown[];
      deltas: unknown[];
    };
    expect(body.updatedAt).toBe(env?.updatedAt);
    expect(body.deltas).toEqual([{ d: 1 }]);
    const parsed = parseCloudSessionSnapshot(body, scope.sessionId);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('second persist suffix-merges this-run messages onto the prior blob (keeps turn-1 user)', async () => {
    const { seam, blobStore } = await makeSeam();
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [{ d: 1 }],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-1 user', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'turn-1 assistant', at: 2 },
        ],
        deltas: [{ d: 1 }],
      }),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [{ d: 2 }],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'turn-2 assistant', at: 2 },
        ],
        deltas: [{ d: 2 }],
      }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const raw = await blobStore.read(second.objectId!);
    const parsed = parseCloudSessionSnapshot(JSON.parse(raw ?? 'null'), scope.sessionId);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
  });

  it('host-shaped prior that already ends with this turn is not duplicated', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'turn-2 user', at: 20 },
          { id: 'h4', role: 'assistant', text: 'turn-2 assistant', at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'turn-2 assistant', at: 2 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.id)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('unreadable leftover { deltas } prior starts from this run only', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({ deltas: [{ d: 0 }] }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [{ id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 }],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual(['turn-2 user']);
  });

  it('bound pointer whose blob is missing fails persist (does not this-run-only replace)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [{ id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 }],
      }),
      fold,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.transcriptPointer).toBe(priorId);
    expect(env?.meta?.turnStatus).toBeUndefined();
    expect(env?.meta?.checkpointPointer).toBeUndefined();
  });

  it('bound pointer whose body is not JSON fails persist (pointer unchanged)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    await blobStore.writeSegment({
      objectId: priorId,
      content: 'not-json{',
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [{ id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 }],
      }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.transcriptPointer).toBe(priorId);
  });

  it('host-encoded tool_run prior is not duplicated when checkpoint tool text differs', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'turn-2 user', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'file content', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'turn-2 assistant', at: 3 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      encoded,
      'turn-2 assistant',
    ]);
    expect(parsed?.messages.map((m) => m.id).slice(0, 4)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('host one tool_run card vs N checkpoint tools is not duplicated', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'turn-2 user', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
          { id: 'h5', role: 'assistant', text: 'turn-2 assistant', at: 22 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'file content', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'exit=0', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'turn-2 assistant', at: 4 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      encoded,
      'turn-2 assistant',
    ]);
    expect(parsed?.messages.map((m) => m.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  it('host tool card vs checkpoint preamble+tools is not duplicated', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'turn-2 user', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read that', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'file looks good', at: 4 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      encoded,
      'Let me read thatfile looks good',
    ]);
    expect(parsed?.messages.map((m) => m.id).slice(0, 4)).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('same user text + tools + different assistant appends the new turn', async () => {
    const { seam, blobStore } = await makeSeam();
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'file content', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'here is the first analysis', at: 3 },
        ],
      }),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'exit=0', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'now I will edit the file', at: 3 },
        ],
      }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(second.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'continue',
      'file content',
      'here is the first analysis',
      'continue',
      'exit=0',
      'now I will edit the file',
    ]);
  });

  it('interleaved per-round assistants vs mid-turn host card keep all this-run assistant prose', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'fix the tests', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read the file', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'I will run the tests', at: 4 },
          { id: 'cp_4', role: 'tool_run', text: 'exit=1', at: 5 },
          { id: 'cp_5', role: 'assistant', text: '3 passed', at: 6 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      encoded,
      'Let me read the fileI will run the tests3 passed',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'tool_run')).toHaveLength(1);
  });

  it('empty last-round vs mid-turn host card keeps skipped this-run assistant prose', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'fix the tests', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read the file', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'I will run the tests', at: 4 },
          { id: 'cp_4', role: 'tool_run', text: 'exit=1', at: 5 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      encoded,
      'Let me read the fileI will run the tests',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'tool_run')).toHaveLength(1);
  });

  it('interleaved per-round assistants vs trailing host concat do not duplicate the user', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    const concat = 'Let me read the file\nI will run the tests\n3 passed';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h2', role: 'tool_run', text: encoded, at: 21 },
          { id: 'h3', role: 'assistant', text: concat, at: 22 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'fix the tests', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read the file', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'I will run the tests', at: 4 },
          { id: 'cp_4', role: 'tool_run', text: 'exit=1', at: 5 },
          { id: 'cp_5', role: 'assistant', text: '3 passed', at: 6 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'fix the tests',
      encoded,
      concat,
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('new assistant ending with a prior short ack appends (no reverse endsWith cover)', async () => {
    const { seam, blobStore } = await makeSeam();
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'file content', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'OK', at: 3 },
        ],
      }),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'exit=0', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'All tests passed. OK', at: 3 },
        ],
      }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(second.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'continue',
      'file content',
      'OK',
      'continue',
      'exit=0',
      'All tests passed. OK',
    ]);
  });

  it('same-user first-round preamble that is a suffix of leftover appends the whole turn', async () => {
    const { seam, blobStore } = await makeSeam();
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'tool_run', text: 'file content', at: 2 },
          { id: 'cp_2', role: 'assistant', text: 'All tests passed. OK', at: 3 },
        ],
      }),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'continue', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'OK', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'exit=0', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'now I will edit the file', at: 4 },
        ],
      }),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(second.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'continue',
      'file content',
      'All tests passed. OK',
      'continue',
      'OK',
      'exit=0',
      'now I will edit the file',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(parsed?.messages.filter((m) => m.role === 'tool_run')).toHaveLength(2);
  });

  it('envelope read throw fails persist (pointer unchanged, not this-run-only)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new ThrowOnceEnvelopeStore();
    const priorId = newBlobObjectId(scope);
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    envelopeStore.armThrow = true;
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [{ id: 'cp_0', role: 'user', text: 'turn-2 user', at: 1 }],
      }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('write_failed');
    const env = await envelopeStore.readEnvelope(key);
    expect(env?.meta?.transcriptPointer).toBe(priorId);
    expect(env?.meta?.turnStatus).toBeUndefined();
  });

  it('worker-to-worker empty last-round persist retry does not duplicate assts', async () => {
    const { seam, blobStore } = await makeSeam();
    const body = {
      id: scope.sessionId,
      messages: [
        { id: 'cp_0', role: 'user' as const, text: 'fix the tests', at: 1 },
        { id: 'cp_1', role: 'assistant' as const, text: 'Let me read the file', at: 2 },
        { id: 'cp_2', role: 'tool_run' as const, text: 'file content', at: 3 },
        { id: 'cp_3', role: 'assistant' as const, text: 'I will run the tests', at: 4 },
        { id: 'cp_4', role: 'tool_run' as const, text: 'exit=1', at: 5 },
      ],
    };
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify(body),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [],
      content: JSON.stringify(body),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(second.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'fix the tests',
      'Let me read the file',
      'file content',
      'I will run the tests',
      'exit=1',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('empty last-round persist retry onto folded mid-turn snapshot does not append leftover tool', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const body = {
      id: scope.sessionId,
      messages: [
        { id: 'cp_0', role: 'user' as const, text: 'fix the tests', at: 1 },
        { id: 'cp_1', role: 'assistant' as const, text: 'Let me read the file', at: 2 },
        { id: 'cp_2', role: 'tool_run' as const, text: 'file content', at: 3 },
        { id: 'cp_3', role: 'assistant' as const, text: 'I will run the tests', at: 4 },
        { id: 'cp_4', role: 'tool_run' as const, text: 'exit=1', at: 5 },
      ],
    };
    const first = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify(body),
    });
    expect(first.ok).toBe(true);
    const second = await seam.persist({
      turnRunId: 'wr_0000_2a3b4c5d6e7f',
      deltas: [],
      content: JSON.stringify(body),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(second.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      encoded,
      'Let me read the fileI will run the tests',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'tool_run')).toHaveLength(1);
    expect(parsed?.messages.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(
      1,
    );
  });

  it('completed host persistTurn trailing Turn ended + nonempty last-round is not duplicated', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const encoded = '{"tools":[{"name":"read_file","ok":true},{"name":"exec","ok":true}]}';
    const concat = 'Let me read the file\nI will run the tests\n3 passed';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h4', role: 'tool_run', text: encoded, at: 21 },
          { id: 'h5', role: 'assistant', text: concat, at: 22 },
          { id: 'h6', role: 'system', text: 'Turn ended · model finished', at: 23 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'fix the tests', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read the file', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'I will run the tests', at: 4 },
          { id: 'cp_4', role: 'tool_run', text: 'exit=1', at: 5 },
          { id: 'cp_5', role: 'assistant', text: '3 passed', at: 6 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      encoded,
      concat,
      'Turn ended · model finished',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('thinking-split two host cards vs interleaved tools keep one user and fold assts', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const priorId = newBlobObjectId(scope);
    const card1 = '{"tools":[{"name":"read_file","ok":true}]}';
    const card2 = '{"tools":[{"name":"exec","ok":true}]}';
    await blobStore.writeSegment({
      objectId: priorId,
      content: JSON.stringify({
        id: scope.sessionId,
        updatedAt: 1000,
        messages: [
          { id: 'h1', role: 'user', text: 'turn-1 user', at: 10 },
          { id: 'h2', role: 'assistant', text: 'turn-1 assistant', at: 11 },
          { id: 'h3', role: 'user', text: 'fix the tests', at: 20 },
          { id: 'h4', role: 'tool_run', text: card1, at: 21 },
          { id: 'h5', role: 'tool_run', text: card2, at: 22 },
        ],
      }),
      maxBytes: 8 * 1024 * 1024,
    });
    await envelopeStore.upsertEnvelope(key, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 1000,
      meta: { transcriptPointer: priorId },
    });
    const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope });
    const res = await seam.persist({
      turnRunId: realRunId,
      deltas: [],
      content: JSON.stringify({
        id: scope.sessionId,
        messages: [
          { id: 'cp_0', role: 'user', text: 'fix the tests', at: 1 },
          { id: 'cp_1', role: 'assistant', text: 'Let me read the file', at: 2 },
          { id: 'cp_2', role: 'tool_run', text: 'file content', at: 3 },
          { id: 'cp_3', role: 'assistant', text: 'I will run the tests', at: 4 },
          { id: 'cp_4', role: 'tool_run', text: 'exit=0', at: 5 },
          { id: 'cp_5', role: 'assistant', text: '3 passed', at: 6 },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = parseCloudSessionSnapshot(
      JSON.parse((await blobStore.read(res.objectId!)) ?? 'null'),
      scope.sessionId,
    );
    expect(parsed?.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      card1,
      card2,
      'Let me read the fileI will run the tests3 passed',
    ]);
    expect(parsed?.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(parsed?.messages.filter((m) => m.role === 'tool_run')).toHaveLength(2);
  });
});
