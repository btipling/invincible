import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../../../../lib/sessions/memorySessionStore';
import type { HarnessSessionRecord } from '../../../../lib/sessions/sessionStore';
import { setSessionStoreForTests } from '../../../../lib/tenancy/harnessSessionsRedis';
import { AUTH_REQUIRED_ERROR } from '../../../../lib/tenancy/errors';

/**
 * Phase 2 (#414) — GET/PUT/DELETE /api/sessions/:id route tests.
 * In-memory `ServerSessionStore` double; no real Redis.
 */
describe('/api/sessions/:id', () => {
  const TENANT = 'tenant-a';
  const USER = 'user-a';
  const originalEnv = { ...process.env };

  function record(id: string, updatedAt = 100): HarnessSessionRecord {
    return {
      id,
      tenantId: TENANT,
      userId: USER,
      createdAt: 1000,
      updatedAt,
      messages: [{ id: `m_${id}`, role: 'user', text: 'hi', at: 50 }],
      meta: {},
    };
  }

  beforeEach(() => {
    setSessionStoreForTests(new MemorySessionStore());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../../lib/tenancy/session');
    vi.doUnmock('../../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../../lib/di');
  });

  /**
   * Seed the DI harnessSessionsRedis resolver. Accepts the loadSoleMembership
   * shape and translates it to the ServiceResult the route reads from
   * `harnessSessionsRedis.resolveTenantIdForUser`.
   */
  function mockTenant(
    input:
      | { ok: true; tenantId: string; role?: string }
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
    vi.doMock('../../../../lib/di', () => ({
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
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@t.com' },
      })),
    }));
    return import('./route');
  }

  function putRequest(id: string, body: unknown): Request {
    return new Request(`http://localhost/api/sessions/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('unauthenticated → 401', async () => {
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET, PUT, DELETE } = await import('./route');
    expect((await GET(new Request('http://localhost/api/sessions/x'), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401);
    expect((await PUT(putRequest('x', record('x')), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401);
    expect((await DELETE(new Request('http://localhost/api/sessions/x'), { params: Promise.resolve({ id: 'x' }) })).status).toBe(401);
  });

  it('tenancy/store unavailable → 503 SESSION_STORE_UNAVAILABLE', async () => {
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: USER },
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost/api/sessions/x'), { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SESSION_STORE_UNAVAILABLE');
  });

  it('store I/O rejection (e.g. dead Redis) → 503 SESSION_STORE_UNAVAILABLE on GET/PUT/DELETE (adv. L1/L6)', async () => {
    const throwingStore: import('../../../../lib/sessions/sessionStore').ServerSessionStore = {
      async get() {
        throw new Error('redis connection refused');
      },
      async put() {
        throw new Error('redis connection refused');
      },
      async list() {
        throw new Error('redis connection refused');
      },
      async remove() {
        throw new Error('redis connection refused');
      },
    };
    setSessionStoreForTests(throwingStore);
    const { GET, PUT, DELETE } = await mockAuthed();

    const resGet = await GET(new Request('http://localhost/api/sessions/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    const resPut = await PUT(putRequest('abc', record('abc')), {
      params: Promise.resolve({ id: 'abc' }),
    });
    const resDel = await DELETE(new Request('http://localhost/api/sessions/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(resGet.status).toBe(503);
    expect(resPut.status).toBe(503);
    expect(resDel.status).toBe(503);
    const body = (await resGet.json()) as { code: string; error: string };
    expect(body.code).toBe('SESSION_STORE_UNAVAILABLE');
    // No leak of host/port/URI/error text to the client.
    expect(JSON.stringify(body)).not.toMatch(/redis|connection|refused|localhost/);
  });

  it('GET existing record; GET missing/other-user id → 404', async () => {
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    await store.put({ tenantId: TENANT, userId: USER, sessionId: 'abc' }, record('abc', 5));

    const { GET } = await mockAuthed();
    const hit = await GET(new Request('http://localhost/api/sessions/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(hit.status).toBe(200);
    const body = (await hit.json()) as { id: string; updatedAt: number };
    expect(body.id).toBe('abc');
    expect(body.updatedAt).toBe(5);

    const miss = await GET(new Request('http://localhost/api/sessions/zzz'), {
      params: Promise.resolve({ id: 'zzz' }),
    });
    expect(miss.status).toBe(404);
    const missBody = (await miss.json()) as { code: string };
    expect(missBody.code).toBe('NOT_FOUND');
  });

  it('PUT body id must equal path id → 400', async () => {
    const { PUT } = await mockAuthed();
    const res = await PUT(
      new Request('http://localhost/api/sessions/abc', {
        method: 'PUT',
        body: JSON.stringify({ id: 'different', updatedAt: 10, messages: [] }),
      }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ID_MISMATCH');
  });

  it('PUT LWW conflict → 409 + server body; equal updatedAt idempotent-accept', async () => {
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    await store.put({ tenantId: TENANT, userId: USER, sessionId: 'abc' }, record('abc', 200));
    const { PUT } = await mockAuthed();

    // stale client (updatedAt 100 < server 200) → 409 with server record.
    const stale = await PUT(putRequest('abc', { id: 'abc', updatedAt: 100, messages: [] }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(stale.status).toBe(409);
    const serverBody = (await stale.json()) as { updatedAt: number; messages: unknown };
    expect(serverBody.updatedAt).toBe(200);
    expect(serverBody.messages).toBeDefined();

    // equal (updatedAt 200 = server) → accepted, 200.
    const equal = await PUT(putRequest('abc', { id: 'abc', updatedAt: 200, messages: [] }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(equal.status).toBe(200);
  });

  it('PUT accepts meta.title (schema-typed reserved) and rejects unknown meta key', async () => {
    const { PUT } = await mockAuthed();

    const ok = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 10, messages: [], meta: { title: 'T' } }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { meta: { title?: string } };
    expect(body.meta.title).toBe('T');

    const bad = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 10, messages: [], meta: { sneaky: 'x' } }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(bad.status).toBe(400);
  });

  it('PUT/GET round-trips meta.{logicalCwd,activeSandboxId}; invalid carrier meta → 400 INVALID_META', async () => {
    const { PUT, GET } = await mockAuthed();

    const ok = await PUT(
      putRequest('abc', {
        id: 'abc',
        updatedAt: 10,
        messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
        meta: { logicalCwd: 'invincible/src', activeSandboxId: 'sbx_abc123' },
      }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(ok.status).toBe(200);
    const stored = (await ok.json()) as {
      meta: { logicalCwd?: string; activeSandboxId?: string };
    };
    expect(stored.meta.logicalCwd).toBe('invincible/src');
    expect(stored.meta.activeSandboxId).toBe('sbx_abc123');

    // GET returns them back
    const got = await GET(new Request('http://localhost/api/sessions/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    const gotBody = (await got.json()) as {
      meta: { logicalCwd?: string; activeSandboxId?: string };
    };
    expect(gotBody.meta.logicalCwd).toBe('invincible/src');
    expect(gotBody.meta.activeSandboxId).toBe('sbx_abc123');

    // host-absolute cwd → 400 INVALID_META
    const badCwd = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 10, messages: [], meta: { logicalCwd: '/etc' } }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(badCwd.status).toBe(400);
    expect(((await badCwd.json()) as { code: string }).code).toBe('INVALID_META');

    // non-Redis-safe sandbox id → 400 INVALID_META
    const badSandbox = await PUT(
      putRequest('abc', { id: 'abc', updatedAt: 10, messages: [], meta: { activeSandboxId: 'a:b' } }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(badSandbox.status).toBe(400);
    expect(((await badSandbox.json()) as { code: string }).code).toBe('INVALID_META');
  });

  it('PUT oversize message bytes → 400 (caps reuse)', async () => {
    const { PUT } = await mockAuthed();
    const { HARNESS_SESSION_MAX_MSG_BYTES } = await import('../../../../lib/sessionCloudCaps');
    const text = 'x'.repeat(HARNESS_SESSION_MAX_MSG_BYTES + 1);
    const res = await PUT(
      putRequest('abc', {
        id: 'abc',
        updatedAt: 10,
        messages: [{ id: 'm1', role: 'user', text, at: 1 }],
      }),
      { params: Promise.resolve({ id: 'abc' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MESSAGE_TOO_LARGE');
  });

  it('gate ok but authed user has no id → 401 AUTH_REQUIRED_ERROR (not 503)', async () => {
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true as const, user: { email: 'a@t.com' } })),
    }));
    mockTenant({ ok: true as const, tenantId: TENANT, role: 'member' });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost/api/sessions/x'), {
      params: Promise.resolve({ id: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('unsafe path id (non Redis-safe charset, e.g. `*`, `a:b`) → 400 INVALID_ID on GET/PUT/DELETE', async () => {
    const { GET, PUT, DELETE } = await mockAuthed();
    for (const badId of ['*', 'a:b', 'sp ace', 'a?b']) {
      const g = await GET(new Request(`http://localhost/api/sessions/${badId}`), {
        params: Promise.resolve({ id: badId }),
      });
      expect(g.status).toBe(400);
      expect(((await g.json()) as { code: string }).code).toBe('INVALID_ID');

      const p = await PUT(
        putRequest(badId, { id: badId, updatedAt: 10, messages: [] }),
        { params: Promise.resolve({ id: badId }) },
      );
      expect(p.status).toBe(400);

      const d = await DELETE(new Request(`http://localhost/api/sessions/${badId}`), {
        params: Promise.resolve({ id: badId }),
      });
      expect(d.status).toBe(400);
      expect(((await d.json()) as { code: string }).code).toBe('INVALID_ID');
    }
  });

  it('DELETE leaves other sessions; idempotent 204', async () => {
    const store = new MemorySessionStore();
    setSessionStoreForTests(store);
    await store.put({ tenantId: TENANT, userId: USER, sessionId: 'a' }, record('a'));
    await store.put({ tenantId: TENANT, userId: USER, sessionId: 'b' }, record('b'));

    const { DELETE, GET } = await mockAuthed();
    const r1 = await DELETE(new Request('http://localhost/api/sessions/a'), {
      params: Promise.resolve({ id: 'a' }),
    });
    const r2 = await DELETE(new Request('http://localhost/api/sessions/a'), {
      params: Promise.resolve({ id: 'a' }),
    });
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(204);

    const bHit = await GET(new Request('http://localhost/api/sessions/b'), {
      params: Promise.resolve({ id: 'b' }),
    });
    expect(bHit.status).toBe(200);
  });
});
