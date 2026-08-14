import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../../../lib/sessions/memorySessionStore';
import { setSessionStoreForTests } from '../../../lib/tenancy/harnessSessionsRedis';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';

/**
 * Phase 2 (#414) — GET/POST /api/sessions collection route tests.
 * Uses the in-memory `ServerSessionStore` double; no real Redis.
 */
describe('/api/sessions', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Inject a fresh MemorySessionStore for the next route import.
    setSessionStoreForTests(new MemorySessionStore());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../lib/di');
  });

  /**
   * Seed the DI harnessSessionsRedis resolver. Accepts the same shape the
   * pre-DI tests used (loadSoleMembership result) and translates it to the
   * ServiceResult (`{ok,code,error}` / `{ok,value}`) the route reads from
   * `harnessSessionsRedis.resolveTenantIdForUser`.
   */
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
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => result),
        },
      }),
      createScriptConnection: vi.fn(),
    }));
  }

  async function loadAuthedRoute(userId = 'user-a') {
    mockTenant({ ok: true as const, tenantId: 'tenant-a' });
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@t.com' },
      })),
    }));
    return import('./route');
  }

  it('unauthenticated → 401', async () => {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET, POST } = await import('./route');
    const resGet = await GET();
    const resPost = await POST(new Request('http://localhost/api/sessions', { method: 'POST', body: '{}' }));
    expect(resGet.status).toBe(401);
    expect(resPost.status).toBe(401);
    const body = (await resPost.json()) as { error: string };
    expect(body.error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('tenancy/store unavailable → 503 SESSION_STORE_UNAVAILABLE', async () => {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-a' },
      })),
    }));
    mockTenant({ ok: false as const, reason: 'db' as const });
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SESSION_STORE_UNAVAILABLE');
  });

  it('store I/O rejection (e.g. dead Redis) → 503 SESSION_STORE_UNAVAILABLE, not 500 (adversarial L1/L6)', async () => {
    const throwingStore: import('../../../lib/sessions/sessionStore').ServerSessionStore = {
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
    const { GET, POST } = await loadAuthedRoute('user-a');

    const resGet = await GET();
    expect(resGet.status).toBe(503);
    const getBody = (await resGet.json()) as { code: string; error: string };
    expect(getBody.code).toBe('SESSION_STORE_UNAVAILABLE');

    const resPost = await POST(new Request('http://localhost/api/sessions', { method: 'POST' }));
    expect(resPost.status).toBe(503);
    const postBody = (await resPost.json()) as { code: string; error: string };
    expect(postBody.code).toBe('SESSION_STORE_UNAVAILABLE');
    // No leak of host/port/URI/credential from the underlying error.
    expect(JSON.stringify(getBody)).not.toMatch(/redis|connection|refused|localhost/);
    expect(JSON.stringify(postBody)).not.toMatch(/redis|connection|refused|localhost/);
  });

  it('POST mints distinct server-minted UUID ids with updatedAt:0 and real createdAt', async () => {
    const { POST } = await loadAuthedRoute();
    const r1 = await POST(new Request('http://localhost/api/sessions', { method: 'POST' }));
    const r2 = await POST(new Request('http://localhost/api/sessions', { method: 'POST' }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const body1 = (await r1.json()) as Record<string, unknown>;
    const body2 = (await r2.json()) as Record<string, unknown>;
    expect(body1.id).toBeTypeOf('string');
    expect(body2.id).toBeTypeOf('string');
    expect(body1.id).not.toBe(body2.id);
    expect(body1.updatedAt).toBe(0);
    expect(body2.updatedAt).toBe(0);
    expect(body1.createdAt).toBeTypeOf('number');
    expect((body1.messages as unknown[]).length).toBe(0);
  });

  it('POST optional title stored under meta.title', async () => {
    const { POST } = await loadAuthedRoute();
    const res = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'My session' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { title?: string } };
    expect(body.meta.title).toBe('My session');
  });

  it('GET list returns only caller sessions as summaries (no messages) with title', async () => {
    // Seed two sessions for user-a via the store directly.
    const { POST } = await loadAuthedRoute('user-a');
    await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'titled' }),
      }),
    );
    await POST(new Request('http://localhost/api/sessions', { method: 'POST' }));

    const { GET } = await loadAuthedRoute('user-a');
    const res = await GET();
    expect(res.status).toBe(200);
    const list = (await res.json()) as {
      id: string;
      createdAt: number;
      updatedAt: number;
      title: string | null;
      messages?: unknown;
    }[];
    expect(list.length).toBe(2);
    for (const row of list) {
      expect(row.messages).toBeUndefined();
      expect(typeof row.id).toBe('string');
      expect(typeof row.createdAt).toBe('number');
      expect(typeof row.updatedAt).toBe('number');
    }
    expect(list.some((r) => r.title === 'titled')).toBe(true);
    expect(list.some((r) => r.title === null)).toBe(true);
  });

  it('POST oversize meta.title → 400 INVALID_META (not 500 store throw)', async () => {
    const { POST } = await loadAuthedRoute();
    const { HARNESS_SESSION_MAX_META_BYTES } = await import('../../../lib/sessionCloudCaps');
    const res = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'x'.repeat(HARNESS_SESSION_MAX_META_BYTES + 1) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_META');
  });

  it('POST invalid title type → 400 INVALID_TITLE', async () => {
    const { POST } = await loadAuthedRoute();
    const res = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: { not: 'a string' } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_TITLE');
  });

  it('POST optional personaId stored under meta.personaId (phase 3 #488)', async () => {
    const { POST } = await loadAuthedRoute();
    const res = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ personaId: 'pers_abc123' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { personaId?: string } };
    expect(body.meta.personaId).toBe('pers_abc123');
  });

  it('POST non-Redis-safe personaId → 400 INVALID_PERSONA_ID', async () => {
    const { POST } = await loadAuthedRoute();
    for (const bad of ['a:b', 'has space', 'x'.repeat(600)]) {
      const res = await POST(
        new Request('http://localhost/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ personaId: bad }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_PERSONA_ID');
    }
  });

  it('cross-user isolation: POST derives tenant from server membership, never client input', async () => {
    const { POST } = await loadAuthedRoute('user-a');
    const res = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ tenantId: 'user-b', userId: 'user-b' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; userId: string };
    expect(body.tenantId).toBe('tenant-a');
    expect(body.userId).toBe('user-a');
  });
});
