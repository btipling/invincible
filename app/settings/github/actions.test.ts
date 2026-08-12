import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings GitHub token actions', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  function mockDi() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).soleMembership = servicesState.soleMembership ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userGithubToken =
      servicesState.userGithubToken ?? {};
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.soleMembership;
    delete servicesState.userGithubToken;
    vi.doUnmock('../../../auth');
    vi.doUnmock('next/cache');
    vi.doUnmock('../../../lib/di');
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

  it('setGithubTokenAction rejects when unauthenticated', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth(null);

    const setUserGithubToken = vi.fn();
    servicesState.userGithubToken = {
      setUserGithubToken,
      clearUserGithubToken: vi.fn(),
    };

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
    mockDi();
    mockAuth({ id: 'session-user' });
    servicesState.soleMembership = {
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    };
    const setUserGithubToken = vi.fn(async () => ({
      ok: true as const,
      value: { updatedAt: new Date() },
    }));
    servicesState.userGithubToken = {
      setUserGithubToken,
      clearUserGithubToken: vi.fn(),
    };

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
    mockDi();
    mockAuth({ id: 'session-user' });
    servicesState.soleMembership = {
      loadSoleMembership: vi.fn(async () => ({
        ok: true,
        tenantId: 't1',
        role: 'member',
      })),
    };
    const clearUserGithubToken = vi.fn(async () => ({
      ok: true as const,
      value: { cleared: true as const },
    }));
    servicesState.userGithubToken = {
      setUserGithubToken: vi.fn(),
      clearUserGithubToken,
    };

    const { clearGithubTokenAction } = await import('./actions');
    const fd = new FormData();
    fd.set('userId', 'attacker-user');
    const r = await clearGithubTokenAction({}, fd);
    expect(r.ok).toBe(true);
    expect(clearUserGithubToken).toHaveBeenCalledWith('session-user');
  });
});
