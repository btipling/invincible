import { afterEach, describe, expect, it, vi } from 'vitest';

// Response.json serializes Date → ISO string; compare against the wire shape.
const summaryA = {
  id: 'persona-a',
  name: 'Frontend',
  slug: 'frontend',
  isDefault: true,
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('GET /api/personas', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/tenancy/session');
  });

  function mockList(
    listUserPersonas: (userId: string) => Promise<unknown> = vi.fn(async () => ({
      ok: true,
      value: [summaryA],
    })),
  ) {
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        userPersonas: { listUserPersonas },
      }),
      createScriptConnection: vi.fn(),
    }));
    return listUserPersonas;
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

  function req(): Request {
    return new Request('http://localhost/api/personas');
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
    mockList();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockList();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns persona summaries WITHOUT body', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockList();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.personas).toEqual([summaryA]);
    expect(JSON.stringify(body)).not.toContain('body');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('empty persona list → []', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockList(vi.fn(async () => ({ ok: true, value: [] })));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.personas).toEqual([]);
  });

  it('list failure unavailable → 503', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockList(vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'x' })));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('list error surfaced as 403', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockList(vi.fn(async () => ({ ok: false, code: 'no_membership', error: 'x' })));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(403);
  });
});
