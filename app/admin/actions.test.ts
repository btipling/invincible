import { afterEach, describe, expect, it, vi } from 'vitest';

describe('admin inference actions authz', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.adminContext;
    delete servicesState.providerSecrets;
    delete servicesState.rotateSandboxToken;
    delete servicesState.rotateTenantDek;
    delete servicesState.manageSandbox;
    vi.doUnmock('../../auth');
    vi.doUnmock('../../lib/di');
    vi.doUnmock('next/cache');
  });

  function tenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  }

  async function load(mockAdminContext: unknown, serviceSlices: unknown) {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'u1' } })),
    }));
    servicesState.adminContext = {
      loadAdminContext: mockAdminContext,
    };
    Object.assign(servicesState, serviceSlices);
    vi.doMock('../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
    const actions = await import('./actions');
    return actions;
  }

  const noopSecrets = {
    createProviderSecret: vi.fn(),
    setProviderSecretModels: vi.fn(),
    setProviderSecretGrants: vi.fn(),
    disableProviderSecret: vi.fn(),
    updateProviderSecret: vi.fn(),
  };

  it('createProviderSecretAction rejects when unauthenticated', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => null),
    }));
    servicesState.adminContext = { loadAdminContext: vi.fn() };
    servicesState.providerSecrets = { ...noopSecrets };
    servicesState.rotateSandboxToken = { rotateSandboxToken: vi.fn() };
    servicesState.rotateTenantDek = { rotateTenantDek: vi.fn() };
    servicesState.manageSandbox = {
      createSandboxForAdmin: vi.fn(),
      updateSandboxForAdmin: vi.fn(),
    };
    vi.doMock('../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));

    const { createProviderSecretAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'k');
    fd.set('provider', 'anthropic');
    fd.set('apiKey', 'sk-test');
    const r = await createProviderSecretAction({}, fd);
    expect(r.error).toMatch(/Authentication required/);
  });

  it('createProviderSecretAction rejects non-admin', async () => {
    const createProviderSecret = vi.fn();
    const actions = await load(
      vi.fn(async () => ({ ok: false, reason: 'forbidden' })),
      { providerSecrets: { ...noopSecrets, createProviderSecret } },
    );
    const fd = new FormData();
    fd.set('name', 'k');
    fd.set('provider', 'anthropic');
    fd.set('apiKey', 'sk-test');
    const r = await actions.createProviderSecretAction({}, fd);
    expect(r.error).toMatch(/Admin access/);
    expect(createProviderSecret).not.toHaveBeenCalled();
  });

  it('disableProviderSecretAction rejects non-admin', async () => {
    const disableProviderSecret = vi.fn();
    const actions = await load(
      vi.fn(async () => ({ ok: false, reason: 'forbidden' })),
      { providerSecrets: { ...noopSecrets, disableProviderSecret } },
    );
    const fd = new FormData();
    fd.set('secretId', 'sec-1');
    const r = await actions.disableProviderSecretAction({}, fd);
    expect(r.error).toMatch(/Admin access/);
    expect(disableProviderSecret).not.toHaveBeenCalled();
  });

  it('updateProviderSecretAction passes session tenantId', async () => {
    const updateProviderSecret = vi.fn(async () => ({ ok: true, value: { id: 'sec-1' } }));
    const actions = await load(
      vi.fn(async () => ({
        ok: true,
        value: {
          tenant: { id: 'tenant-a', slug: 'a', name: 'A' },
          role: 'admin',
          user: { id: 'admin-1', email: 'a@t.com', name: null },
          canAdmin: true,
          canRotate: false,
          sandboxes: [],
        },
      })),
      { providerSecrets: { ...noopSecrets, updateProviderSecret } },
    );
    const fd = new FormData();
    fd.set('secretId', 'sec-1');
    fd.set('name', 'renamed');
    const r = await actions.updateProviderSecretAction({}, fd);
    expect(r.ok).toBe(true);
    expect(updateProviderSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        secretId: 'sec-1',
        tenantId: 'tenant-a',
        name: 'renamed',
      }),
    );
  });
});
