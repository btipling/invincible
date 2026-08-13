import { afterEach, describe, expect, it, vi } from 'vitest';

describe('settings sandbox actions', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.soleMembership;
    delete servicesState.userPreferredSandbox;
    delete servicesState.userSandboxInstance;
    vi.doUnmock('../../../auth');
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

  async function loadActions(mocks: {
    auth?: unknown;
    membership?: unknown;
    domain?: Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listUserSandboxChoices?: any;
  }) {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    vi.doMock('../../../auth', () => ({
      auth:
        mocks.auth ??
        vi.fn(async () => ({ user: { id: 'session-user' } })),
    }));
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
    servicesState.soleMembership = {
      loadSoleMembership:
        mocks.membership ??
        vi.fn(async () => ({
          ok: true,
          tenantId: 't1',
          role: 'member',
        })),
    };
    servicesState.userPreferredSandbox = {
      setUserPreferredSandbox: vi.fn(),
      listUserSandboxChoices:
        mocks.listUserSandboxChoices ??
        vi.fn(async () => ({
          ok: true as const,
          value: {
            preferredSandboxId: null,
            options: [
              {
                sandboxId: 'sbx_a',
                name: 'Alpha',
                slug: 'alpha',
                backend: 'byo',
                status: 'active',
                image: null,
                usable: true,
                granted: true,
                canRead: true,
                canWrite: true,
              },
            ],
          },
        })),
    };
    const domain = {
      createWorkspace: vi.fn(),
      createHttp: vi.fn(),
      startInstance: vi.fn(),
      stopInstance: vi.fn(),
      destroyInstance: vi.fn(),
      ...mocks.domain,
    };
    servicesState.userSandboxInstance = domain;
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

  it('setActiveSandboxAction rejects when unauthenticated', async () => {
    const { actions } = await loadActions({
      auth: vi.fn(async () => null),
    });
    const fd = new FormData();
    fd.set('sandboxId', 'sbx_a');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.error).toMatch(/Authentication required/);
  });

  it('setActiveSandboxAction returns the chosen usable grant sandboxId', async () => {
    const { actions } = await loadActions({});
    const fd = new FormData();
    fd.set('sandboxId', 'sbx_a');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.sandboxId).toBe('sbx_a');
    expect(r.message).toMatch(/Alpha/);
  });

  it('setActiveSandboxAction rejects a non-granted / non-usable row', async () => {
    const { actions } = await loadActions({
      listUserSandboxChoices: vi.fn(async () => ({
        ok: true as const,
        value: {
          preferredSandboxId: null,
          options: [
            {
              sandboxId: 'sbx_x',
              name: 'Ungranted',
              slug: 'ungr',
              backend: 'vercel',
              status: 'active',
              image: null,
              usable: false,
              granted: false,
              canRead: false,
              canWrite: false,
            },
          ],
        },
      })),
    });
    const fd = new FormData();
    fd.set('sandboxId', 'sbx_x');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/not a usable grant/i);
  });

  it('setActiveSandboxAction rejects hostile unknown id', async () => {
    const { actions } = await loadActions({});
    const fd = new FormData();
    fd.set('sandboxId', 'sbx_nope');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/not a usable grant/i);
  });

  it('setActiveSandboxAction rejects missing sandboxId', async () => {
    const { actions } = await loadActions({});
    const fd = new FormData();
    fd.set('sandboxId', '');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/sandboxId is required/i);
  });

  it('setActiveSandboxAction does NOT write the preferred row', async () => {
    const { actions } = await loadActions({});
    const fd = new FormData();
    fd.set('sandboxId', 'sbx_a');
    const r = await actions.setActiveSandboxAction({}, fd);
    expect(r.ok).toBe(true);
    expect(
      servicesState.userPreferredSandbox.setUserPreferredSandbox,
    ).not.toHaveBeenCalled();
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
