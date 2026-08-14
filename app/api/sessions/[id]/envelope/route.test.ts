import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../../../../../lib/sessions/memorySessionStore';
import { newBlobObjectId } from '../../../../../lib/sessions/blobStore';
import { setSessionStoreForTests } from '../../../../../lib/tenancy/harnessSessionsRedis';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Phase 0 (#515) — PUT/GET /api/sessions/:id/envelope (small envelope carrier) tests.
 * In-memory envelope store double; no real Redis.
 */
describe('/api/sessions/:id/envelope', () => {
  const TENANT = 'tenant-a';
  const USER = 'user-a';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setSessionStoreForTests(new MemorySessionStore());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../../../lib/tenancy/session');
    vi.doUnmock('../../../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../../../lib/di');
  });

  function mockTenant(
    input:
      | { ok: true; tenantId: string }
      | { ok: false; reason: 'db' | 'ambiguous' | 'none' },
  ) {
    const result = input.ok
      ? { ok: true as const, value: input.tenantId }
      : input.reason === 'db' || input.reason === 'ambiguous'
        ? {
            ok: false as const,
            code: 'SESSION_STORE_UNAVAILABLE',
            error: 'tenant membership lookup failed',
          }
        : { ok: false as const, code: 'NO_TENANT', error: 'no sole tenant membership' };
    vi.doMock('../../../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => result),
        },
      }),
      createScriptConnection: vi.fn(),
    }));
  }

  async function mockAuthed(userId = USER, tenantId = TENANT) {
    mockTenant({ ok: true as const, tenantId });
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@t.com' },
      })),
    }));
    return import('./route');
  }

  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function putRequest(id: string, body: unknown): Request {
    return new Request(`http://localhost/api/sessions/${id}/envelope`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('unauthenticated → 401', async () => {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET, PUT } = await import('./route');
    expect((await GET(new Request('http://localhost/api/sessions/x'), ctx('x'))).status).toBe(401);
    expect((await PUT(putRequest('x', { id: 'x', updatedAt: 1 }), ctx('x'))).status).toBe(401);
  });

  it('tenancy/store unavailable → 503', async () => {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true as const, user: { id: USER } })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost/api/sessions/abc'), ctx('abc'));
    expect(res.status).toBe(503);
  });

  it('unsafe path id → 400 INVALID_ID', async () => {
    const { GET, PUT } = await mockAuthed();
    for (const badId of ['*', 'a:b', 'sp ace']) {
      expect((await GET(new Request(`http://localhost/api/sessions/${badId}`), ctx(badId))).status).toBe(400);
      expect((await PUT(putRequest(badId, { id: badId, updatedAt: 1 }), ctx(badId))).status).toBe(400);
    }
  });

  it('PUT upserts envelope with meta/pointer; GET reads it back (no transcript)', async () => {
    const { PUT, GET } = await mockAuthed();
    // A pointer must be server-minted and bound to THIS session (Major L2).
    const boundPtr = newBlobObjectId({ tenantId: TENANT, userId: USER, sessionId: 'abc' });
    const put = await PUT(
      putRequest('abc', {
        id: 'abc',
        updatedAt: 10,
        meta: { transcriptPointer: boundPtr },
      }),
      ctx('abc'),
    );
    expect(put.status).toBe(200);
    const stored = (await put.json()) as { id: string; updatedAt: number; meta: { transcriptPointer?: string }; messages?: unknown };
    expect(stored.id).toBe('abc');
    expect(stored.updatedAt).toBe(10);
    expect(stored.meta.transcriptPointer).toBe(boundPtr);
    expect(stored.messages).toBeUndefined();

    const got = await GET(new Request('http://localhost/api/sessions/abc/envelope'), ctx('abc'));
    expect(got.status).toBe(200);
    const env = (await got.json()) as { id: string; meta: { transcriptPointer?: string }; messages?: unknown };
    expect(env.id).toBe('abc');
    expect(env.meta.transcriptPointer).toBe(boundPtr);
    expect(env.messages).toBeUndefined();
  });

  it('PUT body id must equal path id → 400; unknown meta key → 400 INVALID_META; non-safe pointer → 400', async () => {
    const { PUT } = await mockAuthed();
    const mismatch = await PUT(putRequest('abc', { id: 'zzz', updatedAt: 1 }), ctx('abc'));
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { code: string }).code).toBe('ID_MISMATCH');

    const badMeta = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 1, meta: { sneaky: 1 } }),
      ctx('abc'),
    );
    expect(badMeta.status).toBe(400);
    expect(((await badMeta.json()) as { code: string }).code).toBe('INVALID_META');

    const badPointer = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 1, meta: { transcriptPointer: 'a:b' } }),
      ctx('abc'),
    );
    expect(badPointer.status).toBe(400);
  });

  it('PUT rejects a transcriptPointer NOT minted for this session (planted foreign pointer → 400 INVALID_META)', async () => {
    const { PUT } = await mockAuthed();
    // A pointer bound to a DIFFERENT session/tenant cannot be planted onto 'abc'.
    const foreignPtr = newBlobObjectId({
      tenantId: 'tenant-b',
      userId: 'user-b',
      sessionId: 'zzz',
    });
    const planted = await PUT(
      putRequest('abc', {
        id: 'abc',
        updatedAt: 5,
        meta: { transcriptPointer: foreignPtr },
      }),
      ctx('abc'),
    );
    expect(planted.status).toBe(400);
    expect(((await planted.json()) as { code: string }).code).toBe('INVALID_META');
  });

  it('PUT LWW conflict → 409 + server envelope; equal → accepted', async () => {
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    await store.upsertEnvelope(
      { tenantId: TENANT, userId: USER, sessionId: 'abc' },
      { id: 'abc', userId: USER, tenantId: TENANT, updatedAt: 200, meta: { transcriptPointer: 'tx_new' } },
    );
    const { PUT } = await mockAuthed();

    const stale = await PUT(
      putRequest('abc', {
        id: 'abc',
        updatedAt: 100,
        meta: { transcriptPointer: newBlobObjectId({ tenantId: TENANT, userId: USER, sessionId: 'abc' }) },
      }),
      ctx('abc'),
    );
    expect(stale.status).toBe(409);
    const server = (await stale.json()) as { updatedAt: number; meta: { transcriptPointer?: string } };
    expect(server.updatedAt).toBe(200);
    expect(server.meta.transcriptPointer).toBe('tx_new');

    const equal = await PUT(putRequest('abc', { id: 'abc', updatedAt: 200, meta: {} }), ctx('abc'));
    expect(equal.status).toBe(200);
  });

  it('GET missing session → 404; envelope never leaks a transcript', async () => {
    const { GET } = await mockAuthed();
    const res = await GET(new Request('http://localhost/api/sessions/missing/envelope'), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('rollforward: legacy whole-blob record readable as an envelope via GET (no backfill)', async () => {
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    await store.put(
      { tenantId: TENANT, userId: USER, sessionId: 'legacy' },
      {
        id: 'legacy',
        tenantId: TENANT,
        userId: USER,
        createdAt: 1000,
        updatedAt: 7,
        messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
        meta: { title: 'legacy' },
      },
    );
    const { GET } = await mockAuthed();
    const res = await GET(new Request('http://localhost/api/sessions/legacy/envelope'), ctx('legacy'));
    expect(res.status).toBe(200);
    const env = (await res.json()) as { id: string; updatedAt: number; meta: { title?: string }; messages?: unknown };
    expect(env.id).toBe('legacy');
    expect(env.updatedAt).toBe(7);
    expect(env.meta.title).toBe('legacy');
    expect(env.messages).toBeUndefined();
  });
});
