import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings MCP actions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../auth');
    vi.doUnmock('../../../lib/tenancy/enabled');
    vi.doUnmock('../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../lib/tenancy/userMcpServers');
    vi.doUnmock('../../../lib/mcp/client');
    vi.doUnmock('next/cache');
  });

  function tenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
      'base64',
    );
  }

  it('createMcpServerAction rejects when unauthenticated', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => null),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership: vi.fn(),
    }));
    const createUserMcpServer = vi.fn();
    vi.doMock('../../../lib/tenancy/userMcpServers', () => ({
      createUserMcpServer,
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById: vi.fn(),
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError: vi.fn(),
      updateUserMcpServer: vi.fn(),
    }));
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
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'u1' } })),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    }));
    const loadUserMcpSecretById = vi.fn(async () => ({
      ok: true as const,
      value: {
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
      },
    }));
    const setUserMcpServerLastError = vi.fn(async () => ({
      ok: true as const,
      value: { id: 's1' },
    }));
    vi.doMock('../../../lib/tenancy/userMcpServers', () => ({
      createUserMcpServer: vi.fn(),
      deleteUserMcpServer: vi.fn(),
      loadUserMcpSecretById,
      setUserMcpServerEnabled: vi.fn(),
      setUserMcpServerLastError,
      updateUserMcpServer: vi.fn(),
    }));
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
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'u1' } })),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    }));
    const probeUserMcpServer = vi.fn();
    vi.doMock('../../../lib/tenancy/userMcpServers', () => ({
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
    }));
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
});
