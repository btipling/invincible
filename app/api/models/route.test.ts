import { afterEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/models', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/tenancy/session');
  });

  function mockResolveInference(listModelsForUser = vi.fn(async () => [])) {
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        resolveInference: { listModelsForUser },
      }),
      createScriptConnection: vi.fn(),
    }));
    return listModelsForUser;
  }

  function mockSession(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => result),
    }));
  }

  it('unauthenticated → 401', async () => {
    vi.resetModules();
    mockSession({
      ok: false,
      response: Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      ),
    });
    mockResolveInference();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockResolveInference();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns grant-filtered catalog', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference(
      vi.fn(async () => ['anthropic/claude-z', 'anthropic/claude-a']),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'anthropic/claude-z', label: 'claude-z' },
      { id: 'anthropic/claude-a', label: 'claude-a' },
    ]);
  });

  it('empty grant list → empty catalog', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([]);
  });

  it('resolve failure → 503', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference(
      vi.fn(async () => {
        throw new Error('db down');
      }),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
