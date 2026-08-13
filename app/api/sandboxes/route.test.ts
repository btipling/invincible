import { afterEach, describe, expect, it, vi } from 'vitest';

const usableOption = {
  sandboxId: 'sbx_a',
  name: 'Alpha',
  slug: 'alpha',
  backend: 'byo' as const,
  status: 'active',
  image: null,
  usable: true,
  granted: true,
  canRead: true,
  canWrite: true,
};

const secondUsable = {
  sandboxId: 'sbx_b',
  name: 'Beta',
  slug: 'beta',
  backend: 'vercel' as const,
  status: 'active',
  image: 'vercel/sandbox/node:24',
  usable: true,
  granted: true,
  canRead: true,
  canWrite: false,
};

describe('GET /api/sandboxes', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/tenancy/session');
  });

  function mockListOptions(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listUserSandboxChoices: (userId: string) => Promise<any> = vi.fn(async () => ({
      ok: true,
      value: { preferredSandboxId: null, options: [usableOption] },
    })),
  ) {
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        userPreferredSandbox: { listUserSandboxChoices },
      }),
      createScriptConnection: vi.fn(),
    }));
    return listUserSandboxChoices;
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

  function req(query = ''): Request {
    return new Request(`http://localhost/api/sandboxes${query}`);
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
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('returns non-secret options projection + active:null when no sandboxId', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBeNull();
    expect(body.options).toEqual([
      {
        id: 'sbx_a',
        name: 'Alpha',
        slug: 'alpha',
        backend: 'byo',
        status: 'active',
        image: null,
        canRead: true,
        canWrite: true,
        usable: true,
        granted: true,
      },
    ]);
  });

  it('active descriptor for a valid requested sandboxId', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req(`?sandboxId=${usableOption.sandboxId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).not.toBeNull();
    expect(body.active.sandboxId).toBe('sbx_a');
    const names = body.active.tools.map((t: { name: string }) => t.name);
    for (const n of ['list_dir', 'read_file', 'stat', 'write_file', 'str_replace', 'exec', 'change_dir', 'pwd']) {
      expect(names).toContain(n);
    }
  });

  it('active descriptor reflects read-only grant (no write tools)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions(
      vi.fn(async () => ({
        ok: true,
        value: { preferredSandboxId: null, options: [secondUsable] },
      })),
    );
    const { GET } = await import('./route');
    const res = await GET(req('?sandboxId=sbx_b'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.active.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('write_file');
  });

  it('provided-but-unusable sandboxId → 403 (fail closed, no stub active)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req('?sandboxId=sbx_ghost'));
    expect(res.status).toBe(403);
  });

  it('non-Redis-safe sandboxId query → treated as absent (active null)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions();
    const { GET } = await import('./route');
    const res = await GET(req('?sandboxId=bad:value'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBeNull();
  });

  it('list failure unavailable → 503', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1' } });
    mockListOptions(
      vi.fn(async () => ({ ok: false, code: 'unavailable', error: 'x' })),
    );
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(503);
  });
});
