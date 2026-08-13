import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Node-env server-action unit tests (no RTL/jsdom — the repo runs vitest in
 * `environment: 'node'`; sibling Settings pages test actions the same way with
 * mocked DI + auth). These exercise the personas actions end to end against
 * mocked store calls: authz, tenancy, slug dedupe, and error mapping.
 */
describe('settings personas actions', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  function mockDi() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).soleMembership = servicesState.soleMembership ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userPersonas = servicesState.userPersonas ?? {};
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.soleMembership;
    delete servicesState.userPersonas;
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

  function personaStore(overrides: Record<string, unknown> = {}) {
    servicesState.userPersonas = {
      createUserPersona: vi.fn(),
      renameUserPersona: vi.fn(),
      updateUserPersonaBody: vi.fn(),
      deleteUserPersona: vi.fn(),
      setDefaultPersona: vi.fn(),
      clearDefaultPersona: vi.fn(),
      ...overrides,
    };
  }

  it('create rejects unauthenticated and never calls the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth(null);
    personaStore();

    const { createPersonaAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Frontend');
    fd.set('body', 'You are a FE engineer.');
    const r = await createPersonaAction({}, fd);
    expect(r.error).toBe('Authentication required.');
    expect(servicesState.userPersonas.createUserPersona).not.toHaveBeenCalled();
  });

  it('create derives a unique slug and creates (base slug used)', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    personaStore({
      createUserPersona: vi.fn(async (input: { name: string; slug: string; body: string }) =>
        input.slug === 'frontend'
          ? { ok: true as const, value: { id: 'p1' } }
          : { ok: false as const, code: 'duplicate_slug', error: 'dup' },
      ),
    });

    const { createPersonaAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Frontend');
    fd.set('body', 'You are a FE engineer.');
    const r = await createPersonaAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('p1');
    expect(servicesState.userPersonas.createUserPersona).toHaveBeenCalledWith({
      userId: 'u1',
      name: 'Frontend',
      slug: 'frontend',
      body: 'You are a FE engineer.',
      isDefault: false,
    });
  });

  it('create dedupes slug on collision (base taken → _2)', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    const calls: string[] = [];
    personaStore({
      createUserPersona: vi.fn(async (input: { slug: string }) => {
        calls.push(input.slug);
        return input.slug === 'frontend'
          ? { ok: false as const, code: 'duplicate_slug', error: 'dup' }
          : { ok: true as const, value: { id: 'p2' } };
      }),
    });

    const { createPersonaAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Frontend');
    fd.set('body', 'body');
    const r = await createPersonaAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('p2');
    expect(calls).toEqual(['frontend', 'frontend_2']);
  });

  it('create maps store errors to a friendly message', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    personaStore({
      createUserPersona: vi.fn(async (input: { body: string }) =>
        input.body === ''
          ? { ok: false as const, code: 'invalid_body', error: 'bad body' }
          : { ok: true as const, value: { id: 'p' } },
      ),
    });

    const { createPersonaAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Frontend');
    fd.set('body', '');
    const r = await createPersonaAction({}, fd);
    expect(r.error).toMatch(/Body is required/);
  });

  it('rename + updateBody + delete + setDefault + clearDefault route through the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    personaStore({
      renameUserPersona: vi.fn(async () => ({
        ok: true as const,
        value: { id: 'p1' },
      })),
      updateUserPersonaBody: vi.fn(async () => ({
        ok: true as const,
        value: { id: 'p1' },
      })),
      deleteUserPersona: vi.fn(async () => ({
        ok: true as const,
        value: { id: 'p1' },
      })),
      setDefaultPersona: vi.fn(async () => ({
        ok: true as const,
        value: { id: 'p1' },
      })),
      clearDefaultPersona: vi.fn(async () => ({
        ok: true as const,
        value: { cleared: true },
      })),
    });

    const actions = await import('./actions');
    const store = servicesState.userPersonas;

    const fdRename = new FormData();
    fdRename.set('id', 'p1');
    fdRename.set('name', 'Alpha');
    await actions.renamePersonaAction({}, fdRename);
    expect(store.renameUserPersona).toHaveBeenCalledWith('u1', 'p1', 'Alpha');

    const fdBody = new FormData();
    fdBody.set('id', 'p1');
    fdBody.set('body', 'new-body');
    await actions.updatePersonaBodyAction({}, fdBody);
    expect(store.updateUserPersonaBody).toHaveBeenCalledWith('u1', 'p1', 'new-body');

    const fdDel = new FormData();
    fdDel.set('id', 'p1');
    const del = await actions.deletePersonaAction({}, fdDel);
    expect(del.ok).toBe(true);
    expect(store.deleteUserPersona).toHaveBeenCalledWith('u1', 'p1');

    const fdSet = new FormData();
    fdSet.set('id', 'p1');
    const set = await actions.setDefaultPersonaAction({}, fdSet);
    expect(set.ok).toBe(true);
    expect(store.setDefaultPersona).toHaveBeenCalledWith('u1', 'p1');

    const dfd = new FormData();
    const clr = await actions.clearDefaultPersonaAction({}, dfd);
    expect(clr.ok).toBe(true);
    expect(store.clearDefaultPersona).toHaveBeenCalledWith('u1');
  });

  it('delete maps not_found without leaking', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    personaStore({
      deleteUserPersona: vi.fn(async () => ({
        ok: false as const,
        code: 'not_found',
        error: 'persona not found',
      })),
    });

    const { deletePersonaAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 'missing');
    const r = await deletePersonaAction({}, fd);
    expect(r.error).toBe('Persona not found.');
  });
});
