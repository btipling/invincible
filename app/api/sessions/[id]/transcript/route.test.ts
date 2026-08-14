import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBlobTranscriptStore } from '../../../../../lib/sessions/blobStores';
import { MemorySessionStore } from '../../../../../lib/sessions/memorySessionStore';
import {
  setBlobStoreForTests,
  setSessionStoreForTests,
} from '../../../../../lib/tenancy/harnessSessionsRedis';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Phase 0 (#515) — POST/GET /api/sessions/:id/transcript (Blob transcript object seam).
 * Uses in-memory Blob + envelope store doubles; no real Vercel Blob / Redis.
 */
describe('/api/sessions/:id/transcript', () => {
  const TENANT = 'tenant-a';
  const USER = 'user-a';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setBlobStoreForTests(new MemoryBlobTranscriptStore());
    // GET is authorization-bound to the requesting session's envelope pointer, so it
    // needs the session store seam (reader's Major L2).
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

  async function mockAuthed(userId = 'user-a', tenantId = 'tenant-a') {
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

  it('unauthenticated → 401', async () => {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET, POST } = await import('./route');
    expect((await POST(new Request('http://localhost/api/sessions/x/transcript', { method: 'POST' }), ctx('x'))).status).toBe(401);
    expect((await GET(new Request('http://localhost/api/sessions/x/transcript?objectId=tx'), ctx('x'))).status).toBe(401);
  });

  it('tenancy unavailable → 503', async () => {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true as const, user: { id: 'u' } })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { POST } = await import('./route');
    const res = await POST(new Request('http://localhost/api/sessions/abc/transcript', { method: 'POST' }), ctx('abc'));
    expect(res.status).toBe(503);
  });

  it('unsafe path id → 400 INVALID_ID', async () => {
    const { GET, POST } = await mockAuthed();
    for (const badId of ['*', 'a:b', 'sp ace']) {
      expect((await POST(new Request('http://localhost/api/sessions/abc/transcript', { method: 'POST' }), { params: Promise.resolve({ id: badId }) })).status).toBe(400);
      expect((await GET(new Request('http://localhost/api/sessions/abc/transcript?objectId=tx'), { params: Promise.resolve({ id: badId }) })).status).toBe(400);
    }
  });

  it('POST mints a short-lived scoped upload URL + objectId (never the credential)', async () => {
    const { POST } = await mockAuthed();
    const res = await POST(new Request('http://localhost/api/sessions/abc/transcript', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'application/json' }),
    }), ctx('abc'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadUrl: string; objectId: string; readUrl?: string };
    expect(typeof body.uploadUrl).toBe('string');
    expect(body.uploadUrl).toContain('memory://upload/');
    expect(typeof body.objectId).toBe('string');
    // The server's credential/secret never appears.
    expect(JSON.stringify(body)).not.toMatch(/BLOB_READ_WRITE_TOKEN/);
  });

  it('POST invalid contentType → 400; invalid JSON → 400', async () => {
    const { POST } = await mockAuthed();
    const badType = await POST(new Request('http://localhost/api/sessions/abc/transcript', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'a'.repeat(200) }),
    }), ctx('abc'));
    expect(badType.status).toBe(400);

    const badJson = await POST(new Request('http://localhost/api/sessions/abc/transcript', {
      method: 'POST',
      body: '{not json',
    }), ctx('abc'));
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { code: string }).code).toBe('INVALID_JSON');
  });

  it('GET signs ONLY the session envelope pointer (authorization-bound); missing → 404; bad objectId → 400', async () => {
    // Setup: mint an object AND bind that objectId as this session's envelope pointer.
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    const blob = new MemoryBlobTranscriptStore();
    setBlobStoreForTests(blob);

    const mint = await blob.mintUpload({
      scope: { tenantId: TENANT, userId: USER, sessionId: 'abc' },
    });
    await store.upsertEnvelope(
      { tenantId: TENANT, userId: USER, sessionId: 'abc' },
      { id: 'abc', userId: USER, tenantId: TENANT, updatedAt: 10, meta: { transcriptPointer: mint.objectId } },
    );
    const { GET } = await mockAuthed();

    // Bound pointer → signed read URL (the only object this session may read).
    const ok = await GET(
      new Request(`http://localhost/api/sessions/abc/transcript?objectId=${mint.objectId}`),
      ctx('abc'),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { readUrl: string; objectId: string };
    expect(body.readUrl).toContain('memory://transcript/');
    expect(body.objectId).toBe(mint.objectId);

    // IDOR: an arbitrary (even Redis-safe) objectId minted for a DIFFERENT session
    // (same user) and NOT on this session's envelope → 404, never signed under the
    // caller's auth (reader's Major L2).
    const foreign = await blob.mintUpload({
      scope: { tenantId: TENANT, userId: USER, sessionId: 'other' },
    });
    const idor = await GET(
      new Request(`http://localhost/api/sessions/abc/transcript?objectId=${foreign.objectId}`),
      ctx('abc'),
    );
    expect(idor.status).toBe(404);

    // A different session's row (same user) must NOT serve another session's pointer.
    await store.upsertEnvelope(
      { tenantId: TENANT, userId: USER, sessionId: 'other' },
      { id: 'other', userId: USER, tenantId: TENANT, updatedAt: 10, meta: { transcriptPointer: foreign.objectId } },
    );
    const crossSession = await GET(
      new Request(`http://localhost/api/sessions/abc/transcript?objectId=${foreign.objectId}`),
      ctx('abc'),
    );
    expect(crossSession.status).toBe(404);

    // Planted pointer (different tenant/user) directly on this session's envelope:
    // even though `owned.pointer === objectId`, the object-binding re-derivation must
    // reject it (reader's Major L2 defense in depth) — never signed.
    const crossUser = await blob.mintUpload({
      scope: { tenantId: 'tenant-b', userId: 'user-b', sessionId: 'zzz' },
    });
    await store.upsertEnvelope(
      { tenantId: TENANT, userId: USER, sessionId: 'abc' },
      {
        id: 'abc',
        userId: USER,
        tenantId: TENANT,
        updatedAt: 11,
        meta: { transcriptPointer: crossUser.objectId },
      },
    );
    const planted = await GET(
      new Request(`http://localhost/api/sessions/abc/transcript?objectId=${crossUser.objectId}`),
      ctx('abc'),
    );
    expect(planted.status).toBe(404);

    // Envelope present but no pointer → 404.
    await store.upsertEnvelope(
      { tenantId: TENANT, userId: USER, sessionId: 'noptr' },
      { id: 'noptr', userId: USER, tenantId: TENANT, updatedAt: 10, meta: {} },
    );
    const noPtr = await GET(
      new Request(`http://localhost/api/sessions/noptr/transcript?objectId=${mint.objectId}`),
      ctx('noptr'),
    );
    expect(noPtr.status).toBe(404);

    // No session at all → 404.
    const missing = await GET(
      new Request('http://localhost/api/sessions/ghost/transcript?objectId=tx_missing'),
      ctx('ghost'),
    );
    expect(missing.status).toBe(404);

    // Malformed objectId → 400 INVALID_OBJECT_ID.
    const badObj = await GET(
      new Request('http://localhost/api/sessions/abc/transcript?objectId=a:b'),
      ctx('abc'),
    );
    expect(badObj.status).toBe(400);
    expect(((await badObj.json()) as { code: string }).code).toBe('INVALID_OBJECT_ID');
  });
});
