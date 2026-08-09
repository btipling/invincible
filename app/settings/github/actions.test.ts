import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings GitHub token actions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../auth');
    vi.doUnmock('../../../lib/tenancy/enabled');
    vi.doUnmock('../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../lib/tenancy/userGithubToken');
    vi.doUnmock('next/cache');
  });

  function tenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
      'base64',
    );
  }

  it('setGithubTokenAction rejects when unauthenticated', async () => {
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
    const setUserGithubToken = vi.fn();
    vi.doMock('../../../lib/tenancy/userGithubToken', () => ({
      setUserGithubToken,
      clearUserGithubToken: vi.fn(),
    }));

    const { setGithubTokenAction } = await import('./actions');
    const fd = new FormData();
    fd.set('token', 'ghp_secret');
    const r = await setGithubTokenAction({}, fd);
    expect(r.error).toMatch(/Authentication required/);
    expect(setUserGithubToken).not.toHaveBeenCalled();
  });

  it('setGithubTokenAction uses session userId only', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'session-user' } })),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    }));
    const setUserGithubToken = vi.fn(async () => ({
      ok: true as const,
      value: { updatedAt: new Date() },
    }));
    vi.doMock('../../../lib/tenancy/userGithubToken', () => ({
      setUserGithubToken,
      clearUserGithubToken: vi.fn(),
    }));

    const { setGithubTokenAction } = await import('./actions');
    const fd = new FormData();
    fd.set('token', 'ghp_from_form');
    fd.set('userId', 'attacker-user');
    const r = await setGithubTokenAction({}, fd);
    expect(r.ok).toBe(true);
    expect(setUserGithubToken).toHaveBeenCalledWith(
      'session-user',
      'ghp_from_form',
    );
  });

  it('clearGithubTokenAction uses session userId only', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'session-user' } })),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    }));
    const clearUserGithubToken = vi.fn(async () => ({
      ok: true as const,
      value: { cleared: true as const },
    }));
    vi.doMock('../../../lib/tenancy/userGithubToken', () => ({
      setUserGithubToken: vi.fn(),
      clearUserGithubToken,
    }));

    const { clearGithubTokenAction } = await import('./actions');
    const fd = new FormData();
    fd.set('userId', 'attacker-user');
    const r = await clearGithubTokenAction({}, fd);
    expect(r.ok).toBe(true);
    expect(clearUserGithubToken).toHaveBeenCalledWith('session-user');
  });

  it('setGithubTokenAction rejects when tenancy off', async () => {
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => false,
    }));
    vi.doMock('../../../auth', () => ({
      auth: vi.fn(async () => ({ user: { id: 'u1' } })),
    }));
    const setUserGithubToken = vi.fn();
    vi.doMock('../../../lib/tenancy/userGithubToken', () => ({
      setUserGithubToken,
      clearUserGithubToken: vi.fn(),
    }));

    const { setGithubTokenAction } = await import('./actions');
    const fd = new FormData();
    fd.set('token', 'ghp_x');
    const r = await setGithubTokenAction({}, fd);
    expect(r.error).toMatch(/Tenancy is not enabled/);
    expect(setUserGithubToken).not.toHaveBeenCalled();
  });
});
