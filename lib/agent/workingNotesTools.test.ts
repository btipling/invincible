/**
 * Plan #938 — `working_notes_*` tools (source #550, backend-agents A2).
 * In-memory envelope double via `MemorySessionStore`; the overlay writer is
 * injected (stub) so no live Redis / Blob. Covers:
 *   1. get — empty / stored / unavailable
 *   2. update — persist, bounded reject (never truncate), clear verb,
 *      honest store-down, LWW retry (first conflict then success)
 *   3. clear — stored → unset; unavailable honest
 *   4. identity — the route-resolved userId/sessionId only (model args ignored
 *      by construction: no id input schema)
 */
import { describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type {
  ServerSessionStore,
  SessionEnvelope,
  SessionEnvelopeInput,
  SessionEnvelopeStore,
  SessionRecordKey,
} from '../sessions/sessionStore';
import { WORKING_NOTES_MAX_BYTES } from '../sessionCloudCaps';
import {
  createWorkingNotesTools,
  isWorkingNotesToolName,
  type WorkingNotesOverlayWriter,
} from './workingNotesTools';
import { overlayWorkerMeta } from './workerMetaOverlay';

const key: SessionRecordKey = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

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

function seamFor(store: ServerSessionStore, failTenant = false, failStore = false) {
  return {
    resolveSessionStore: vi.fn(async () =>
      failStore
        ? ({ ok: false as const, code: 'store_down', error: 'down' })
        : ({ ok: true as const, value: store }),
    ),
    resolveTenantIdForUser: vi.fn(async () =>
      failTenant
        ? ({ ok: false as const, code: 'tenant', error: 'no tenant' })
        : ({ ok: true as const, value: key.tenantId }),
    ),
  };
}

async function seedEnvelope(
  store: MemorySessionStore,
  meta: Record<string, unknown>,
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

function makeTools(
  store: ServerSessionStore,
  overrides: Partial<{
    overlay: WorkingNotesOverlayWriter;
    failTenant: boolean;
    failStore: boolean;
    /** Explicitly OMIT the sessionId (no-sessionId honesty case). */
    noSessionId?: boolean;
    sessionId?: string;
  }> = {},
) {
  return createWorkingNotesTools({
    userId: key.userId,
    ...(overrides.noSessionId ? {} : { sessionId: overrides.sessionId ?? key.sessionId }),
    sessionStoreSeam: seamFor(store, overrides.failTenant, overrides.failStore),
    ...(overrides.overlay ? { overlayWorkerMeta: overrides.overlay } : {}),
  });
}

describe('working_notes_get', () => {
  it('returns (empty) when the session has no notes block', async () => {
    const store = new MemorySessionStore();
    const { working_notes_get } = makeTools(store);
    await expect(working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      '(empty — no working notes for this session)',
    );
  });

  it('returns the stored block text', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { workingNotes: 'stored finding #1' }, 1000);
    const { working_notes_get } = makeTools(store);
    await expect(working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      'stored finding #1',
    );
  });

  it('is honest when the store is unreachable (never a fake empty)', async () => {
    const store = new MemorySessionStore();
    const { working_notes_get } = makeTools(store, { failStore: true });
    await expect(working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      '(unavailable — session store not reachable; notes cannot be read right now)',
    );
  });

  it('is honest when no sessionId is bound', async () => {
    const store = new MemorySessionStore();
    const { working_notes_get } = makeTools(store, { noSessionId: true });
    await expect(working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      '(unavailable — session store not reachable; notes cannot be read right now)',
    );
  });
});

describe('working_notes_update', () => {
  it('persists the block via the worker overlay (best-effort at tool-execute)', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { personaId: 'p_1' }, 1000);
    const { working_notes_update } = makeTools(store, {
      overlay: overlayWorkerMeta,
    });
    const out = (await working_notes_update.execute!(
      { notes: '  decided: fold after persona  ' },
      undefined as never,
    )) as string;
    expect(out).toContain('working notes updated');
    const env = await store.readEnvelope(key);
    expect(env?.meta.workingNotes).toBe('decided: fold after persona');
    expect(env?.meta.personaId).toBe('p_1'); // host key survived the worker PATCH
  });

  it('REJECTS an over-cap write with an explicit error — never truncates, never persists', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { workingNotes: 'keep me' }, 1000);
    const { working_notes_update } = makeTools(store, { overlay: overlayWorkerMeta });
    const out = (await working_notes_update.execute!(
      { notes: 'x'.repeat(WORKING_NOTES_MAX_BYTES + 1) },
      undefined as never,
    )) as string;
    expect(out).toContain('ERROR working_notes_update');
    expect(out).toContain('32 KiB');
    expect(out).toContain('never truncated');
    const env = await store.readEnvelope(key);
    expect(env?.meta.workingNotes).toBe('keep me'); // unchanged
  });

  it('empty string clears the block', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { workingNotes: 'old' }, 1000);
    const { working_notes_update } = makeTools(store, { overlay: overlayWorkerMeta });
    const out = (await working_notes_update.execute!({ notes: '' }, undefined as never)) as string;
    expect(out).toContain('cleared');
    const env = await store.readEnvelope(key);
    expect(env?.meta.workingNotes).toBeUndefined();
  });

  it('is honest when the store is unavailable (no false success)', async () => {
    const store = new MemorySessionStore();
    const { working_notes_update } = makeTools(store, { failStore: true });
    const out = (await working_notes_update.execute!(
      { notes: 'never persisted' },
      undefined as never,
    )) as string;
    expect(out).toContain('not persisted');
    expect(out).not.toContain('working notes updated');
  });

  it('is honest when the overlay writer reports failure (no false success)', async () => {
    const store = new MemorySessionStore();
    const failing: WorkingNotesOverlayWriter = vi.fn(async () => ({
      ok: false,
      code: 'lww_conflict',
      error: 'conflict',
    }));
    const { working_notes_update } = makeTools(store, { overlay: failing });
    const out = (await working_notes_update.execute!(
      { notes: 'never persisted' },
      undefined as never,
    )) as string;
    expect(out).toContain('not persisted');
  });

  it('retries once on LWW conflict then persists (bounded retry)', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { workingNotes: 'old' }, 1000);
    let calls = 0;
    const flaky: WorkingNotesOverlayWriter = vi.fn(async (input) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, code: 'lww_conflict', error: 'conflict' };
      }
      return overlayWorkerMeta(input);
    });
    const { working_notes_update } = makeTools(store, { overlay: flaky });
    const out = (await working_notes_update.execute!(
      { notes: 'retried finding' },
      undefined as never,
    )) as string;
    expect(out).toContain('working notes updated');
    expect(calls).toBe(2);
    const env = await store.readEnvelope(key);
    expect(env?.meta.workingNotes).toBe('retried finding');
  });

  it('non-string notes input is an explicit error (never thrown)', async () => {
    const store = new MemorySessionStore();
    const { working_notes_update } = makeTools(store);
    const out = (await working_notes_update.execute!(
      { notes: 42 as never },
      undefined as never,
    )) as string;
    expect(out).toContain('ERROR working_notes_update');
  });
});

describe('working_notes_clear', () => {
  it('clears a stored block', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, { workingNotes: 'stale', personaId: 'p_1' }, 1000);
    const { working_notes_clear } = makeTools(store, { overlay: overlayWorkerMeta });
    const out = (await working_notes_clear.execute!({} as never, undefined as never)) as string;
    expect(out).toContain('cleared');
    const env = await store.readEnvelope(key);
    expect(env?.meta.workingNotes).toBeUndefined();
    expect(env?.meta.personaId).toBe('p_1');
  });

  it('is honest when the store is unavailable', async () => {
    const store = new MemorySessionStore();
    const { working_notes_clear } = makeTools(store, { failStore: true });
    const out = (await working_notes_clear.execute!({} as never, undefined as never)) as string;
    expect(out).toContain('not cleared');
  });
});

describe('isWorkingNotesToolName', () => {
  it('gates the reserved prefix for the route soft-path 403 guard', () => {
    expect(isWorkingNotesToolName('working_notes_get')).toBe(true);
    expect(isWorkingNotesToolName('working_notes_update')).toBe(true);
    expect(isWorkingNotesToolName('working_notes_clear')).toBe(true);
    expect(isWorkingNotesToolName('meta_sandbox_list')).toBe(false);
    expect(isWorkingNotesToolName('find_skill')).toBe(false);
    expect(isWorkingNotesToolName('')).toBe(false);
  });
});

describe('envelope round-trip (MemorySessionStore envelope seam)', () => {
  it('a persisted block is read back by working_notes_get (survives the write→read cycle)', async () => {
    const store = new MemorySessionStore();
    await seedEnvelope(store, {}, 1000);
    const tools = makeTools(store, { overlay: overlayWorkerMeta });
    await tools.working_notes_update.execute!({ notes: 'durable finding' }, undefined as never);
    await expect(tools.working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      'durable finding',
    );
  });
});

describe('layering', () => {
  it('createWorkingNotesTools never constructs I/O — the seam closures are required', async () => {
    // The tool factory must not resolve any store itself; without a seam it
    // cannot even be built (type-level) — here we assert the honest-unavailable
    // path when the seam reports failure.
    const store = new MemorySessionStore();
    const tools = makeTools(store, { failTenant: true });
    await expect(tools.working_notes_get.execute!({} as never, undefined as never)).resolves.toBe(
      '(unavailable — session store not reachable; notes cannot be read right now)',
    );
  });
});
