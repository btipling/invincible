import { afterEach, describe, expect, it, vi } from 'vitest';

describe('admin inference actions authz', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../auth');
    vi.doUnmock('../../lib/tenancy/adminContext');
    vi.doUnmock('../../lib/tenancy/enabled');
    vi.doUnmock('../../lib/tenancy/providerSecrets');
    vi.doUnmock('next/cache');
  });

  it('createProviderSecretAction rejects when unauthenticated', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => null),
    }));
    vi.doMock('../../lib/tenancy/providerSecrets', () => ({
      createProviderSecret: vi.fn(),
      setProviderSecretModels: vi.fn(),
      setProviderSecretGrants: vi.fn(),
      disableProviderSecret: vi.fn(),
      updateProviderSecret: vi.fn(),
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
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'u1' } })),
    }));
    vi.doMock('../../lib/tenancy/adminContext', () => ({
      loadAdminContext: vi.fn(async () => ({ ok: false, reason: 'forbidden' })),
    }));
    const createProviderSecret = vi.fn();
    vi.doMock('../../lib/tenancy/providerSecrets', () => ({
      createProviderSecret,
      setProviderSecretModels: vi.fn(),
      setProviderSecretGrants: vi.fn(),
      disableProviderSecret: vi.fn(),
      updateProviderSecret: vi.fn(),
    }));

    const { createProviderSecretAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'k');
    fd.set('provider', 'anthropic');
    fd.set('apiKey', 'sk-test');
    const r = await createProviderSecretAction({}, fd);
    expect(r.error).toMatch(/Admin access/);
    expect(createProviderSecret).not.toHaveBeenCalled();
  });
});
