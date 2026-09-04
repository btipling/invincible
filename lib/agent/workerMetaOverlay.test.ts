/**
 * backend-agents B8 — `overlayWorkerMeta` / `patchWorkerMeta` (copy-forward
 * worker overlay PATCH vs the host PUT/GET clear-on-absent overlay). In-memory
 * envelope double; no live Blob / Redis. Covers the plan's 12-row testing matrix.
 */
import { describe, it, expect } from 'vitest';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type {
  ServerSessionStore,
  SessionEnvelopeInput,
  SessionRecordKey,
} from '../sessions/sessionStore';
import type { HarnessSessionMeta } from '../sessions/sessionStore';
import { patchWorkerMeta, overlayWorkerMeta } from './workerMetaOverlay';
import { WORKING_NOTES_MAX_BYTES } from '../sessionCloudCaps';

const key: SessionRecordKey = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

/** Seed a stored envelope with the given meta + updatedAt; returns the store. */
async function seed(
  store: MemorySessionStore,
  meta: HarnessSessionMeta,
  updatedAt: number,
): Promise<void> {
  const input: SessionEnvelopeInput = {
    id: key.sessionId,
    userId: key.userId,
    tenantId: key.tenantId,
    updatedAt,
    meta,
  };
  await store.upsertEnvelope(key, input);
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

describe('patchWorkerMeta (pure copy-forward)', () => {
  it('matrix 1 — PATCH one worker key preserves host keys byte-for-byte', () => {
    const host = {
      personaId: 'p_1',
      personaSnapshot: 'body',
      title: 'My session',
      selectedModel: 'harness-default',
      legacySnapshotId: 'legacy_1',
      transcriptPointer: 't_old_ptr_0000',
    };
    const out = patchWorkerMeta(host, { turnStatus: 'running' });
    expect(out).toEqual({ ...host, turnStatus: 'running' });
  });

  it('matrix 2 — an absent worker key keeps the previous value (never cleared)', () => {
    const current = { turnRunId: 'wr_0000', turnStatus: 'idle', personaId: 'p_1' };
    const out = patchWorkerMeta(current, { turnStatus: 'running' });
    expect(out.turnRunId).toBe('wr_0000'); // absent worker key preserved
    expect(out.turnStatus).toBe('running');
    expect(out.personaId).toBe('p_1'); // host preserved
  });

  it('matrix 3 — run-id shaped turnRunId accepted (trimmed)', () => {
    const out = patchWorkerMeta({}, { turnRunId: '  2cvk_f1l0p9heqtzB7cX  ' });
    expect(out.turnRunId).toBe('2cvk_f1l0p9heqtzB7cX');
  });

  it('matrix 4 — poisoned / oversized turnRunId drops to unset; siblings + host preserved', () => {
    const current = { turnStatus: 'running', personaId: 'p_1' };
    const out = patchWorkerMeta(current, { turnRunId: 'not opaque:with colon' });
    expect(out.turnRunId).toBeUndefined(); // dropped to unset
    expect(out.turnStatus).toBe('running'); // sibling preserved
    expect(out.personaId).toBe('p_1'); // host preserved
  });

  it('matrix 7 — Redis-safe opaque checkpointPointer accepted', () => {
    const out = patchWorkerMeta({}, { checkpointPointer: 'ckpt_0000_aaaa' });
    expect(out.checkpointPointer).toBe('ckpt_0000_aaaa');
  });

  it('matrix 8 — poisoned checkpointPointer dropped; host preserved', () => {
    const out = patchWorkerMeta({ personaId: 'p_1' }, { checkpointPointer: 'bad pointer' });
    expect(out.checkpointPointer).toBeUndefined();
    expect(out.personaId).toBe('p_1');
  });

  it('plan #936 — Redis-safe modelMessagesPointer accepted; poison dropped; host preserved', () => {
    expect(patchWorkerMeta({}, { modelMessagesPointer: 't_mm_s1_abc' }).modelMessagesPointer).toBe(
      't_mm_s1_abc',
    );
    const out = patchWorkerMeta({ personaId: 'p_1' }, { modelMessagesPointer: 'bad pointer' });
    expect(out.modelMessagesPointer).toBeUndefined();
    expect(out.personaId).toBe('p_1');
  });

  it('plan #938 — workingNotes PATCH accepted (freeform text); poison drops only this key; host preserved', () => {
    // Freeform agent-authored text — length-only cap, no charset restriction.
    expect(
      patchWorkerMeta({}, { workingNotes: 'found: auth seam in lib/tenancy/session.ts' })
        .workingNotes,
    ).toBe('found: auth seam in lib/tenancy/session.ts');
    // Empty string is the clear verb (present `''` so upsert copy-forward
    // does not restore — adversarial #940).
    expect(
      patchWorkerMeta({ workingNotes: 'old' }, { workingNotes: '' }).workingNotes,
    ).toBe('');
    // Over-cap poison is the same present-clear marker; siblings + host preserved.
    const out = patchWorkerMeta(
      { personaId: 'p_1', turnStatus: 'running' },
      { workingNotes: 'x'.repeat(WORKING_NOTES_MAX_BYTES + 1) },
    );
    expect(out.workingNotes).toBe('');
    expect(out.personaId).toBe('p_1');
    expect(out.turnStatus).toBe('running');
  });

  it('matrix 11 — completed turnStatus preserved (first-class terminal)', () => {
    expect(patchWorkerMeta({}, { turnStatus: 'completed' }).turnStatus).toBe('completed');
  });

  it('matrix 12 — turnStreamCursor=0 preserved (non-vacuous)', () => {
    expect(patchWorkerMeta({}, { turnStreamCursor: 0 }).turnStreamCursor).toBe(0);
  });

  it('plan #906 — copies resolvedProvider; absent patch keeps previous; poison drops only this key', () => {
    const current = {
      resolvedProvider: 'togetherai',
      turnStatus: 'running',
      selectedModel: 'moonshotai/kimi-k3',
    };
    expect(patchWorkerMeta(current, { resolvedProvider: 'Fireworks' }).resolvedProvider).toBe(
      'fireworks',
    );
    expect(patchWorkerMeta(current, { turnStatus: 'completed' }).resolvedProvider).toBe(
      'togetherai',
    );
    const poisoned = patchWorkerMeta(current, {
      resolvedProvider: 'moonshotai/kimi-k3',
    });
    expect(poisoned.resolvedProvider).toBeUndefined();
    expect(poisoned.turnStatus).toBe('running');
    expect(poisoned.selectedModel).toBe('moonshotai/kimi-k3');
  });
});

describe('overlayWorkerMeta (LWW copy-forward PATCH)', () => {
  it('plan #906 — overlay copies resolvedProvider; poison drops only this key', async () => {
    const store = new MemorySessionStore();
    await seed(
      store,
      {
        resolvedProvider: 'togetherai',
        turnStatus: 'running',
        selectedModel: 'moonshotai/kimi-k3',
      },
      1000,
    );
    const copy = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { resolvedProvider: 'Fireworks' },
      updatedAt: 2000,
    });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.meta.resolvedProvider).toBe('fireworks');
    expect(copy.meta.selectedModel).toBe('moonshotai/kimi-k3');
    expect(copy.meta.turnStatus).toBe('running');

    const keep = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'completed' },
      updatedAt: 3000,
    });
    expect(keep.ok).toBe(true);
    if (!keep.ok) return;
    expect(keep.meta.resolvedProvider).toBe('fireworks');
    expect(keep.meta.turnStatus).toBe('completed');

    const poison = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { resolvedProvider: 'moonshotai/kimi-k3' },
      updatedAt: 4000,
    });
    expect(poison.ok).toBe(true);
    if (!poison.ok) return;
    expect(poison.meta.resolvedProvider).toBeUndefined();
    expect(poison.meta.selectedModel).toBe('moonshotai/kimi-k3');
    expect(poison.meta.turnStatus).toBe('completed');
  });

  it('matrix 1 — PATCH one worker key over a host-heavy envelope preserves ALL host keys', async () => {
    const store = new MemorySessionStore();
    const host = {
      personaId: 'p_1',
      personaSnapshot: 'body',
      title: 'My session',
      selectedModel: 'harness-default',
      legacySnapshotId: 'legacy_1',
      transcriptPointer: 't_old_ptr_0000',
    };
    await seed(store, { ...host, turnRunId: 'wr_0000', turnStatus: 'idle' }, 1000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'running' },
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta).toEqual({
      ...host,
      turnRunId: 'wr_0000',
      turnStatus: 'running',
    });
  });

  it('matrix 2 — an absent worker key in a PATCH is untouched; host untouched', async () => {
    const store = new MemorySessionStore();
    await seed(
      store,
      { turnRunId: 'wr_0000', turnStatus: 'idle', turnStreamCursor: 7, personaId: 'p_1' },
      1000,
    );
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'running' }, // only turnStatus provided
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.turnRunId).toBe('wr_0000'); // other worker keys preserved
    expect(res.meta.turnStreamCursor).toBe(7);
    expect(res.meta.turnStatus).toBe('running');
    expect(res.meta.personaId).toBe('p_1');
  });

  it('matrix 3 — run-id shaped turnRunId accepted and stored trimmed', async () => {
    const store = new MemorySessionStore();
    await seed(store, { personaId: 'p_1' }, 1000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnRunId: '  2cvk_f1l0p9heqtzB7cX  ' },
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.turnRunId).toBe('2cvk_f1l0p9heqtzB7cX');
    expect(res.meta.personaId).toBe('p_1'); // host preserved through the worker PATCH
  });

  it('matrix 4 — NEVER write turnRunId: sessionId; a sessionId-shaped attempt (no prior run id) drops to unset', async () => {
    const store = new MemorySessionStore();
    await seed(store, { turnStatus: 'running', personaId: 'p_1' }, 1000);
    // Attempt to plant the session id onto the run-id carrier.
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnRunId: key.sessionId }, // session-id-shaped value
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.turnRunId).toBeUndefined(); // no prior run id → drops to unset
    expect(res.meta.turnStatus).toBe('running'); // sibling preserved
    expect(res.meta.personaId).toBe('p_1'); // host preserved
  });

  it('matrix 4b — sessionId-shaped turnRunId PATCH does NOT clear a previously stored real run id (PR #827 Nit L1)', async () => {
    const store = new MemorySessionStore();
    await seed(store, { turnRunId: '2cvk_real', turnStatus: 'running', personaId: 'p_1' }, 1000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnRunId: key.sessionId }, // session-id-shaped attempt
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.turnRunId).toBe('2cvk_real'); // previous real run id survives
    expect(res.meta.turnStatus).toBe('running'); // sibling preserved
    expect(res.meta.personaId).toBe('p_1'); // host preserved
  });

  it('matrix 5 — stale updatedAt LWW conflict: ok:false, nothing written', async () => {
    const store = new MemorySessionStore();
    await seed(store, { turnStatus: 'idle', transcriptPointer: 't_old_ptr' }, 2000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'running' },
      updatedAt: 1000, // stale — older than the stored 2000
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('lww_conflict');
    const env = await store.readEnvelope(key);
    expect(env?.meta?.turnStatus).toBe('idle'); // unchanged
    expect(env?.meta?.transcriptPointer).toBe('t_old_ptr');
    expect(env?.updatedAt).toBe(2000);
  });

  it('matrix 6 — equal updatedAt (no-op) is a conflict: no write, no regress', async () => {
    const store = new MemorySessionStore();
    await seed(store, { turnStatus: 'idle' }, 1500);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'running' },
      updatedAt: 1500, // equal — no-op
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('lww_conflict');
    const env = await store.readEnvelope(key);
    expect(env?.meta?.turnStatus).toBe('idle');
    expect(env?.updatedAt).toBe(1500);
  });

  it('matrix 7 — checkpointPointer in a PATCH accepted; body never in meta', async () => {
    const store = new MemorySessionStore();
    await seed(store, { transcriptPointer: 't_old_ptr' }, 1000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { checkpointPointer: 'ckpt_0000_aaaa' },
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.checkpointPointer).toBe('ckpt_0000_aaaa');
    // Only the object id rides in meta — never a checkpoint body.
    expect(Object.keys(res.meta)).not.toContain('checkpointBody');
    expect(Object.keys(res.meta)).not.toContain('checkpointFile');
  });

  it('matrix 8 — poisoned checkpointPointer dropped; host siblings preserved', async () => {
    const store = new MemorySessionStore();
    await seed(store, { transcriptPointer: 't_old_ptr', personaId: 'p_1' }, 1000);
    const res = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { checkpointPointer: 'bad pointer with spaces' },
      updatedAt: 2000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.checkpointPointer).toBeUndefined();
    expect(res.meta.transcriptPointer).toBe('t_old_ptr'); // sibling host-ish preserved
    expect(res.meta.personaId).toBe('p_1');
  });

  it('matrix 9 — non-envelope store → ok:false, never throws', async () => {
    const bare = new BareStore();
    const res = await overlayWorkerMeta({
      envelopeStore: bare,
      key,
      patch: { turnStatus: 'running' },
      updatedAt: 2000,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_envelope_store');
  });

  it('plan #938 — workingNotes overlay: copy-forward persists the block; host keys survive', async () => {
    const store = new MemorySessionStore();
    await seed(store, { personaId: 'p_1', turnStatus: 'idle' }, 1000);
    const write = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { workingNotes: 'finding: the notes block rides the envelope' },
      updatedAt: 2000,
    });
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.meta.workingNotes).toBe('finding: the notes block rides the envelope');
    expect(write.meta.personaId).toBe('p_1');
    expect(write.meta.turnStatus).toBe('idle');

    // A second PATCH on an unrelated worker key keeps the notes (copy-forward).
    const second = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStatus: 'completed' },
      updatedAt: 3000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.meta.workingNotes).toBe('finding: the notes block rides the envelope');

    // Explicit empty-string PATCH clears only the notes key.
    const clear = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { workingNotes: '' },
      updatedAt: 4000,
    });
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    expect(clear.meta.workingNotes).toBeUndefined();
    expect(clear.meta.personaId).toBe('p_1');
  });

  it('matrix 10 — two successive worker PATCHes: append semantics, no key loss', async () => {
    const store = new MemorySessionStore();
    await seed(store, { transcriptPointer: 't_old_ptr' }, 1000);
    await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnRunId: 'wr_0000', turnStatus: 'running' },
      updatedAt: 2000,
    });
    const second = await overlayWorkerMeta({
      envelopeStore: store,
      key,
      patch: { turnStreamCursor: 7 },
      updatedAt: 3000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.meta.turnRunId).toBe('wr_0000'); // survives across PATCHes
    expect(second.meta.turnStatus).toBe('running');
    expect(second.meta.turnStreamCursor).toBe(7);
    expect(second.meta.transcriptPointer).toBe('t_old_ptr'); // host preserved
  });
});
