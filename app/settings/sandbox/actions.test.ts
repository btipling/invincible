import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings sandbox actions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../auth');
    vi.doUnmock('../../../lib/tenancy/soleMembership');
    vi.doUnmock('../../../lib/tenancy/userPreferredSandbox');
    vi.doUnmock('../../../lib/tenancy/userSandboxInstance');
    vi.doUnmock('next/cache');
  });

  function tenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString(
      'base64',
    );
  }

  async function loadActions(mocks: {
    auth?: unknown;
    membership?: unknown;
    domain?: Record<string, unknown>;
  }) {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../auth', () => ({
      auth:
        mocks.auth ??
        vi.fn(async () => ({ user: { id: 'session-user' } })),
    }));
    vi.doMock('../../../lib/tenancy/soleMembership', () => ({
      loadSoleMembership:
        mocks.membership ??
        vi.fn(async () => ({
          ok: true,
          tenantId: 't1',
          role: 'member',
        })),
    }));
    vi.doMock('../../../lib/tenancy/userPreferredSandbox', () => ({
      setUserPreferredSandbox: vi.fn(),
    }));
    const domain = {
      createWorkspace: vi.fn(),
      createHttp: vi.fn(),
      startInstance: vi.fn(),
      stopInstance: vi.fn(),
      destroyInstance: vi.fn(),
      ...mocks.domain,
    };
    vi.doMock('../../../lib/tenancy/userSandboxInstance', () => domain);
    const actions = await import('./actions');
    return { actions, domain };
  }

  it('createInstanceAction rejects when unauthenticated', async () => {
    const { actions, domain } = await loadActions({
      auth: vi.fn(async () => null),
    });
    const fd = new FormData();
    fd.set('purpose', 'workspace');
    const r = await actions.createInstanceAction({}, fd);
    expect(r.error).toMatch(/Authentication required/);
    expect(domain.createWorkspace).not.toHaveBeenCalled();
    expect(domain.createHttp).not.toHaveBeenCalled();
  });

  it('createInstanceAction uses session userId only for workspace', async () => {
    const createWorkspace = vi.fn(async () => ({
      ok: true as const,
      value: { purpose: 'workspace' },
    }));
    const { actions, domain } = await loadActions({
      domain: { createWorkspace },
    });
    const fd = new FormData();
    fd.set('purpose', 'workspace');
    fd.set('userId', 'attacker-user');
    const r = await actions.createInstanceAction({}, fd);
    expect(r.ok).toBe(true);
    expect(createWorkspace).toHaveBeenCalledWith('session-user');
    expect(domain.createHttp).not.toHaveBeenCalled();
  });

  it('createInstanceAction createHttp happy path', async () => {
    const createHttp = vi.fn(async () => ({
      ok: true as const,
      value: { purpose: 'http' },
    }));
    const { actions, domain } = await loadActions({
      domain: { createHttp },
    });
    const fd = new FormData();
    fd.set('purpose', 'http');
    const r = await actions.createInstanceAction({}, fd);
    expect(r.ok).toBe(true);
    expect(createHttp).toHaveBeenCalledWith('session-user');
    expect(domain.createWorkspace).not.toHaveBeenCalled();
  });

  it('createInstanceAction rejects invalid purpose', async () => {
    const { actions, domain } = await loadActions({});
    const fd = new FormData();
    fd.set('purpose', 'evil');
    const r = await actions.createInstanceAction({}, fd);
    expect(r.error).toMatch(/Invalid purpose/);
    expect(domain.createWorkspace).not.toHaveBeenCalled();
    expect(domain.createHttp).not.toHaveBeenCalled();
  });

  it('destroyInstanceAction happy path', async () => {
    const destroyInstance = vi.fn(async () => ({
      ok: true as const,
      value: { destroyed: true as const },
    }));
    const { actions } = await loadActions({ domain: { destroyInstance } });
    const fd = new FormData();
    fd.set('purpose', 'workspace');
    fd.set('userId', 'attacker');
    const r = await actions.destroyInstanceAction({}, fd);
    expect(r.ok).toBe(true);
    expect(destroyInstance).toHaveBeenCalledWith('session-user', 'workspace');
  });

  it('startInstanceAction maps platform failure', async () => {
    const startInstance = vi.fn(async () => ({
      ok: false as const,
      code: 'platform' as const,
      error: 'Sandbox not found on platform — Destroy and Create again',
    }));
    const { actions } = await loadActions({ domain: { startInstance } });
    const fd = new FormData();
    fd.set('purpose', 'http');
    const r = await actions.startInstanceAction({}, fd);
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/Destroy and Create/);
  });

  it('stopInstanceAction happy path', async () => {
    const stopInstance = vi.fn(async () => ({
      ok: true as const,
      value: { status: 'stopped' },
    }));
    const { actions } = await loadActions({ domain: { stopInstance } });
    const fd = new FormData();
    fd.set('purpose', 'http');
    const r = await actions.stopInstanceAction({}, fd);
    expect(r.ok).toBe(true);
    expect(stopInstance).toHaveBeenCalledWith('session-user', 'http');
  });

  it('settings sandbox modules do not import @vercel/sandbox', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src).not.toMatch(/@vercel\/sandbox/);
      expect(src).not.toMatch(/Sandbox\.create|getOrCreate/);
    }
  });
});
