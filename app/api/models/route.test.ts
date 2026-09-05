import { afterEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/models', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/gateway/modelCatalog');
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

  function mockJoinedEffortMap(
    map: Map<string, string[]> = new Map(),
    windowMap: Map<string, number> = new Map(),
  ) {
    vi.doMock('../../../lib/gateway/modelCatalog', () => ({
      getJoinedEffortMap: vi.fn(async () => map),
      getJoinedWindowMap: vi.fn(async () => windowMap),
    }));
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
    mockJoinedEffortMap();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockResolveInference();
    mockJoinedEffortMap();
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
    mockJoinedEffortMap(
      new Map([
        ['anthropic/claude-a', ['low', 'high']],
      ]),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'anthropic/claude-z', label: 'claude-z', reasoningOptions: [] },
      {
        id: 'anthropic/claude-a',
        label: 'claude-a',
        reasoningOptions: ['low', 'high'],
      },
    ]);
  });

  it('empty grant list → empty catalog', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference();
    mockJoinedEffortMap();
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
    mockJoinedEffortMap();
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('catalog throw still 200 with empty reasoningOptions', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference(vi.fn(async () => ['zai/glm-5.3-flash']));
    vi.doMock('../../../lib/gateway/modelCatalog', () => ({
      getJoinedEffortMap: vi.fn(async () => {
        throw new Error('catalog down');
      }),
      getJoinedWindowMap: vi.fn(async () => {
        throw new Error('catalog down');
      }),
    }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'zai/glm-5.3-flash', label: 'glm-5.3-flash', reasoningOptions: [] },
    ]);
  });

  it('glm-5.3-flash overlay list is returned as reasoningOptions', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference(vi.fn(async () => ['zai/glm-5.3-flash']));
    mockJoinedEffortMap(
      new Map([['zai/glm-5.3-flash', ['low', 'high', 'xhigh']]]),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      {
        id: 'zai/glm-5.3-flash',
        label: 'glm-5.3-flash',
        reasoningOptions: ['low', 'high', 'xhigh'],
      },
    ]);
  });

  it('row 13 (plan #944) — a published window rides the entry; an unpublished window is omitted (never fabricated)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockResolveInference(
      vi.fn(async () => ['openai/gpt-5.6', 'zai/glm-5.3-flash']),
    );
    mockJoinedEffortMap(
      new Map(),
      new Map([['openai/gpt-5.6', 400_000]]),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      {
        id: 'openai/gpt-5.6',
        label: 'gpt-5.6',
        reasoningOptions: [],
        contextWindow: 400_000,
      },
      // Unpublished → the field is simply absent (host falls back to the
      // conservative default; never a fabricated window).
      { id: 'zai/glm-5.3-flash', label: 'glm-5.3-flash', reasoningOptions: [] },
    ]);
  });
});
