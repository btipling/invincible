import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings MCP actions', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  function mockDi() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).soleMembership = servicesState.soleMembership ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userMcpServers =
      servicesState.userMcpServers ?? {};
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.soleMembership;
    delete servicesState.userMcpServers;
    vi.doUnmock('../../../auth');
    vi.doUnmock('../../../lib/mcp/client');
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('next/cache');
  });

  function tenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
      'base64',
    );
  }

  function mockAuth(user: { id: string } | null) {
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => (user ? { user } : null)),
    }));
  }

  function mockMembership(value: unknown) {
    servicesState.soleMembership = {
      loadSoleMembership: vi.fn(async () => value),
    };
  }

  const fakeSecret = {
    id: 's1',
    tenantId: 't1',
    userId: 'u1',
    name: 'Exa',
    slug: 'exa',
    url: 'https://mcp.exa.ai/mcp',
    transport: 'http',
    authHeaderName: 'x-api-key',
    authMode: 'api_key',
    apiKey: 'k',
    enabled: true,
    lastError: 'old',
  };

  it('createMcpServerAction rejects when unauthenticated', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth(null);

    const createUserMcpServer = vi.fn();
    servicesState.userMcpServers = {
      createUserMcpServer,
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(),
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    };
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer: vi.fn(),
    }));

    const { createMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Exa');
    fd.set('slug', 'exa');
    fd.set('url', 'https://mcp.exa.ai/mcp');
    const r = await createMcpServerAction({}, fd);
    expect(r.error).toMatch(/Authentication required/);
    expect(createUserMcpServer).not.toHaveBeenCalled();
  });

  it('testMcpServerAction uses probe and clears last_error on success', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'member' });

    const loadUserMcpSecretById = vi.fn(async () => ({
      ok: true as const,
      value: fakeSecret,
    }));
    const setUserMcpServerLastError = vi.fn(async () => ({
      ok: true as const,
      value: { id: 's1' },
    }));
    servicesState.userMcpServers = {
      createUserMcpServer: vi.fn(),
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById,
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError,
      updateUserMcpServer: vi.fn(),
    };
    const probeUserMcpServer = vi.fn(async () => ({
      ok: true as const,
      toolNames: ['web_search', 'other'],
    }));
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer,
    }));

    const { testMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 's1');
    const r = await testMcpServerAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.toolCount).toBe(2);
    expect(probeUserMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://mcp.exa.ai/mcp',
        apiKey: 'k',
      }),
    );
    expect(setUserMcpServerLastError).toHaveBeenCalledWith('u1', 's1', null);
  });

  it('testMcpServerAction rejects foreign/missing id via load', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'member' });

    const probeUserMcpServer = vi.fn();
    servicesState.userMcpServers = {
      createUserMcpServer: vi.fn(),
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(async () => ({
        ok: false as const,
        code: 'not_found' as const,
        error: 'MCP server not found',
      })),
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    };
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer,
    }));

    const { testMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 'other-users-row');
    const r = await testMcpServerAction({}, fd);
    expect(r.error).toMatch(/not found/i);
    expect(probeUserMcpServer).not.toHaveBeenCalled();
  });

  it('createMcpServerAction passes enabled:false atomically (no disable follow-up)', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'member' });

    const createUserMcpServer = vi.fn(async () => ({
      ok: true as const,
      value: { id: 's-new' },
    }));
    const setUserMcpServerEnabled = vi.fn();
    servicesState.userMcpServers = {
      createUserMcpServer,
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(),
      setUserMcpServerEnabled,
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    };
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer: vi.fn(),
    }));

    const { createMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Off');
    fd.set('slug', 'off');
    fd.set('url', 'https://mcp.example.com/mcp');
    // no enabled checkbox → false
    const r = await createMcpServerAction({}, fd);
    expect(r.ok).toBe(true);
    expect(createUserMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, slug: 'off' }),
    );
    expect(setUserMcpServerEnabled).not.toHaveBeenCalled();
  });

  it('createMcpServerAction surfaces ambiguous membership distinctly', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: false, reason: 'ambiguous' });

    const createUserMcpServer = vi.fn();
    servicesState.userMcpServers = {
      createUserMcpServer,
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(),
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    };
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer: vi.fn(),
    }));

    const { createMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'X');
    fd.set('slug', 'x');
    fd.set('url', 'https://mcp.example.com/mcp');
    const r = await createMcpServerAction({}, fd);
    expect(r.error).toMatch(/Multiple tenant memberships/);
    expect(createUserMcpServer).not.toHaveBeenCalled();
  });

  it('createMcpServerAction surfaces membership db failure distinctly', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: false, reason: 'db' });

    const createUserMcpServer = vi.fn();
    servicesState.userMcpServers = {
      createUserMcpServer,
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(),
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    };
    vi.doMock('../../../lib/mcp/client', () => ({
      probeUserMcpServer: vi.fn(),
    }));

    const { createMcpServerAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'X');
    fd.set('slug', 'x');
    fd.set('url', 'https://mcp.example.com/mcp');
    const r = await createMcpServerAction({}, fd);
    expect(r.error).toMatch(/database unavailable/i);
    expect(createUserMcpServer).not.toHaveBeenCalled();
  });
});
