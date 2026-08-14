import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBlobTranscriptStore } from '../../../../../lib/sessions/blobStores';
import { setBlobStoreForTests } from '../../../../../lib/tenancy/harnessSessionsRedis';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Phase 0 (#515) — POST/GET /api/sessions/:id/transcript (Blob transcript object seam).
 * Uses an in-memory Blob store double; no real Vercel Blob.
 */
describe('/api/sessions/:id/transcript', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setBlobStoreForTests(new MemoryBlobTranscriptStore());
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

  it('GET returns a server-signed read URL for an object; missing object → 404; bad objectId → 400', async () => {
    const blob = new MemoryBlobTranscriptStore();
    setBlobStoreForTests(blob);
    const mint = await blob.mintUpload({ keyPrefix: 'harness/tenant-a/user-a/abc' });
    const { GET } = await mockAuthed();

    const ok = await GET(
      new Request(`http://localhost/api/sessions/abc/transcript?objectId=${mint.objectId}`),
      ctx('abc'),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { readUrl: string; objectId: string };
    expect(body.readUrl).toContain('memory://transcript/');
    expect(body.objectId).toBe(mint.objectId);

    const missing = await GET(
      new Request('http://localhost/api/sessions/abc/transcript?objectId=tx_missing'),
      ctx('abc'),
    );
    expect(missing.status).toBe(404);

    const badObj = await GET(
      new Request('http://localhost/api/sessions/abc/transcript?objectId=a:b'),
      ctx('abc'),
    );
    expect(badObj.status).toBe(400);
    expect(((await badObj.json()) as { code: string }).code).toBe('INVALID_OBJECT_ID');
  });
});
