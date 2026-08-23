import { describe, it, expect, vi } from 'vitest';
import { createTurnWorkerPersist, type TurnWorkerMetaPatch } from './turnWorkerPersist';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import { mapProviderUsage } from './usageSummary';
import type { SessionRecordKey } from '../sessions/sessionStore';

/**
 * backend-agents E (#791 / source #768): worker-persist seam helper tests — plan
 * test row 6. The WORKER is the Blob writer when detached (parent #764 decision:
 * worker writes incrementally, host PUTs are a cache when attached; LWW on
 * `updatedAt`). Covers:
 *   - append-only Blob segment + advances `meta.transcriptPointer`,
 *   - envelope meta upsert overlays only the worker-owned keys (never wipes the
 *     host/sibling surface),
 *   - LWW on `updatedAt` (the store rejects an older write),
 *   - message checkpoint stored as its OWN Blob object, NEVER in envelope meta,
 *   - fail closed: a failed segment PUT never advances the pointer.
 */

const KEY: SessionRecordKey = {
  tenantId: 'tenant_a',
  userId: 'user_1',
  sessionId: 'session_x',
};
const OTHER = 'preserved';

/** Capture the body a recorded upload PUT; memory store can't, so we inject a put spy to ALSO write into a read-shim. */
async function makeSeam(opts: { failSegmentPut?: boolean } = {}) {
  const blob = new MemoryBlobTranscriptStore();
  const env = new MemorySessionStore();
  // Seed a host-authored envelope so overlay-copy behavior is observable.
  await env.upsertEnvelope(KEY, {
    id: KEY.sessionId,
    tenantId: KEY.tenantId,
    userId: KEY.userId,
    updatedAt: 1000,
    meta: { title: 't', logicalCwd: 'host-cwd', selectedModel: 'm1' },
  });
  const putObject = vi.fn(async (url: string, body: unknown): Promise<boolean> => {
    if (opts.failSegmentPut) return false;
    // Record the uploaded body into the memory store under the minted object id
    // so a later `read` returns it (transparent with the memory double).
    const m = /memory:\/\/upload\/([A-Za-z0-9_-]+)$/.exec(url);
    const id = m ? m[1] : undefined;
    if (id) {
      // Memory store seeded a placeholder at mint; overwrite via a raw capture.
      // We can't reach into the private map, so track uploads in a public map.
      uploaded.set(id, body);
    }
    return true;
  });
  const uploaded = new Map<string, unknown>();
  const seam = createTurnWorkerPersist({ blobStore: blob, envelopeStore: env, putObject });
  return { seam, blob, env, putObject, uploaded };
}

describe('turnWorkerPersist', () => {
  it('persistTranscriptSegment PUTs the segment and advances transcriptPointer + worker meta', async () => {
    const { seam, uploaded, env } = await makeSeam();
    const res = await seam.persistTranscriptSegment(KEY, {
      segment: { kind: 'segment', rows: ['assistant text'] },
      updatedAt: 2000,
      metaPatch: {
        logicalCwd: 'worker-cwd',
        activeSandboxId: 'sand_a',
        usage: mapProviderUsage({ inputTokens: 10, outputTokens: 5 }),
        attachedSkills: '["create-plan"]',
        turnRunId: 'run_123',
        turnStatus: 'running',
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok || !res.objectId) throw new Error('expected ok');
    expect(res.envelope?.meta.transcriptPointer).toBe(res.objectId);
    // Worker-owned keys overlaid; non-worker keys preserved (not wiped).
    expect(res.envelope?.meta.logicalCwd).toBe('worker-cwd');
    expect(res.envelope?.meta.activeSandboxId).toBe('sand_a');
    expect(res.envelope?.meta.turnRunId).toBe('run_123');
    expect(res.envelope?.meta.turnStatus).toBe('running');
    expect(res.envelope?.meta.attachedSkills).toBe('["create-plan"]');
    expect(typeof res.envelope?.meta.usage).toBe('string');
    expect(res.envelope?.meta.title).toBe('t'); // sibling surface preserved
    expect(res.envelope?.meta.selectedModel).toBe('m1'); // sibling surface preserved

    // The segment body was the appended payload handed to the PUT.
    expect(uploaded.size).toBe(1);
    expect(uploaded.get(res.objectId)).toEqual({ kind: 'segment', rows: ['assistant text'] });

    // Store read-back: pointer persisted + LWW timestamps advanced.
    const envNow = await env.readEnvelope(KEY);
    expect(envNow?.updatedAt).toBe(2000);
    expect(envNow?.meta.transcriptPointer).toBe(res.objectId);

    // A SECOND append is a NEW object (append-only); pointer advances to the newest.
    const two = await seam.persistTranscriptSegment(KEY, {
      segment: { rows: ['more'] },
      updatedAt: 3000,
    });
    expect(two.ok).toBe(true);
    if (!two.ok || !two.objectId) throw new Error('expected ok');
    expect(uploaded.size).toBe(2);
    expect((await env.readEnvelope(KEY))?.meta.transcriptPointer).toBe(two.objectId);
  });

  it('persistTranscriptSegment fails CLOSED when the segment PUT fails — pointer NOT advanced', async () => {
    const { seam, env } = await makeSeam({ failSegmentPut: true });
    const res = await seam.persistTranscriptSegment(KEY, {
      segment: { rows: ['x'] },
      updatedAt: 2000,
      metaPatch: { turnStatus: 'running' },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected fail');
    expect(res.code).toBe('BLOB_PUT_FAILED');
    // Envelope untouched by the failed write — no pointer, no status flip.
    const envNow = await env.readEnvelope(KEY);
    expect(envNow?.meta.transcriptPointer).toBeUndefined();
    expect(envNow?.meta.turnStatus).toBeUndefined();
    expect(envNow?.updatedAt).toBe(1000);
  });

  it('persistEnvelopeMeta PATCH-overlays only worker keys; LWW on updatedAt', async () => {
    const { seam, env } = await makeSeam();
    const patch: TurnWorkerMetaPatch = { turnStatus: 'done', turnRunId: 'run_9' };
    const okRes = await seam.persistEnvelopeMeta(KEY, { updatedAt: 1500, patch });
    expect(okRes.ok).toBe(true);
    const envNow = await env.readEnvelope(KEY);
    expect(envNow?.meta.turnStatus).toBe('done');
    expect(envNow?.meta.turnRunId).toBe('run_9');
    // Non-worker keys preserved by the overlay (host cwd not even in the patch).
    expect(envNow?.meta.logicalCwd).toBe('host-cwd');
    expect(envNow?.meta.title).toBe('t');
    expect(envNow?.meta.selectedModel).toBe('m1');

    // LWW: an OLDER write is rejected by the store (envelope stays at 1500).
    const oldRes = await seam.persistEnvelopeMeta(KEY, { updatedAt: 1200, patch: { turnStatus: 'running' } });
    expect(oldRes.ok).toBe(false);
    if (oldRes.ok) throw new Error('expected LWW conflict');
    expect(oldRes.code).toBe('ENVELOPE_CONFLICT');
    expect((await env.readEnvelope(KEY))?.meta.turnStatus).toBe('done');
  });

  it('persistEnvelopeMeta CLEARS the run carrier on completion (absent = clear, adversary Major #2)', async () => {
    const { seam, env } = await makeSeam();
    // Seed a live carrier (as the route sets it at start).
    await env.upsertEnvelope(KEY, {
      id: KEY.sessionId,
      tenantId: KEY.tenantId,
      userId: KEY.userId,
      updatedAt: 2500,
      meta: { title: 't', logicalCwd: 'host-cwd', turnRunId: 'run_123', turnStatus: 'running' },
    });
    const patch: TurnWorkerMetaPatch = {
      logicalCwd: 'worker-cwd',
      clearKeys: ['turnRunId', 'turnStatus'],
    };
    const res = await seam.persistEnvelopeMeta(KEY, { updatedAt: 2800, patch });
    expect(res.ok).toBe(true);
    const envNow = await env.readEnvelope(KEY);
    // Carrier released (409 lock cleared) so the next prompt can run.
    expect(Object.prototype.hasOwnProperty.call(envNow?.meta ?? {}, 'turnRunId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(envNow?.meta ?? {}, 'turnStatus')).toBe(false);
    // Non-worker side effects preserved + real worker values applied.
    expect(envNow?.meta.title).toBe('t');
    expect(envNow?.meta.logicalCwd).toBe('worker-cwd');
  });

  it('persistMessageCheckpoint stores the checkpoint as its OWN Blob object and NEVER touches envelope meta', async () => {
    const { seam, uploaded, env } = await makeSeam();
    const checkpoint = {
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    };
    const res = await seam.persistMessageCheckpoint(KEY, { checkpoint, updatedAt: 2500 });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.objectId) throw new Error('expected ok');
    // Checkpoint object created.
    expect(uploaded.has(res.objectId)).toBe(true);
    expect(uploaded.get(res.objectId)).toEqual(checkpoint);

    // The envelope meta was NOT changed by the checkpoint write — no pointer, no
    // checkpoint-in-meta collision (the plan-review Major: never store the 1 MB
    // checkpoint in the 1 MiB whole-meta wire). It stays at the host-authored seed.
    const envNow = await env.readEnvelope(KEY);
    expect(envNow?.meta.transcriptPointer).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(envNow?.meta ?? {}, 'checkpoint')).toBe(false);
    expect(envNow?.meta.title).toBe('t');
  });
});
