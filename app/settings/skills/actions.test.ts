import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Node-env server-action unit tests (no RTL/jsdom — the repo runs vitest in
 * `environment: 'node'`; sibling Settings pages test actions the same way with
 * mocked DI + auth). These exercise the skills actions end to end against
 * mocked store calls: authz, tenancy, slug dedupe, description-edit mapping,
 * and error handling.
 */
describe('settings skills actions', () => {
  const originalEnv = { ...process.env };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  function mockDi() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).soleMembership = servicesState.soleMembership ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userSkills = servicesState.userSkills ?? {};
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.soleMembership;
    delete servicesState.userSkills;
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

  function skillStore(overrides: Record<string, unknown> = {}) {
    servicesState.userSkills = {
      createUserSkill: vi.fn(),
      updateUserSkillSummary: vi.fn(),
      updateUserSkillBody: vi.fn(),
      deleteUserSkill: vi.fn(),
      ...overrides,
    };
  }

  it('create rejects unauthenticated and never calls the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth(null);
    skillStore();

    const { createSkillAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Create PR');
    fd.set('body', 'You create pull requests.');
    const r = await createSkillAction({}, fd);
    expect(r.error).toBe('Authentication required.');
    expect(servicesState.userSkills.createUserSkill).not.toHaveBeenCalled();
  });

  it('create derives a unique slug and creates (base slug used)', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      createUserSkill: vi.fn(
        async (input: { name: string; slug: string; body: string }) =>
          input.slug === 'create_pr'
            ? { ok: true as const, value: { id: 's1' } }
            : { ok: false as const, code: 'duplicate_slug', error: 'dup' },
      ),
    });

    const { createSkillAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Create PR');
    fd.set('body', 'You create pull requests.');
    fd.set('description', 'PR helper');
    const r = await createSkillAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('s1');
    expect(servicesState.userSkills.createUserSkill).toHaveBeenCalledWith({
      userId: 'u1',
      name: 'Create PR',
      slug: 'create_pr',
      body: 'You create pull requests.',
      description: 'PR helper',
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
    skillStore({
      createUserSkill: vi.fn(async (input: { slug: string }) => {
        calls.push(input.slug);
        return input.slug === 'review'
          ? { ok: false as const, code: 'duplicate_slug', error: 'dup' }
          : { ok: true as const, value: { id: 's2' } };
      }),
    });

    const { createSkillAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Review');
    fd.set('body', 'body');
    const r = await createSkillAction({}, fd);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('s2');
    expect(calls).toEqual(['review', 'review_2']);
  });

  it('create maps store errors to a friendly message', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      createUserSkill: vi.fn(async () => ({
        ok: false as const,
        code: 'invalid_body',
        error: 'bad body',
      })),
    });

    const { createSkillAction } = await import('./actions');
    const fd = new FormData();
    fd.set('name', 'Frontend');
    fd.set('body', '');
    const r = await createSkillAction({}, fd);
    expect(r.error).toMatch(/Body is required/);
  });

  it('update details maps rename + description together via updateUserSkillSummary', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      updateUserSkillSummary: vi.fn(async () => ({
        ok: true as const,
        value: { id: 's1' },
      })),
    });

    const { updateSkillDetailsAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 's1');
    fd.set('name', 'Alpha');
    fd.set('description', 'New summary');
    const r = await updateSkillDetailsAction({}, fd);
    expect(r.ok).toBe(true);
    expect(servicesState.userSkills.updateUserSkillSummary).toHaveBeenCalledWith(
      'u1',
      's1',
      { name: 'Alpha', description: 'New summary' },
    );
  });

  it('update body + delete route through the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      updateUserSkillBody: vi.fn(async () => ({
        ok: true as const,
        value: { id: 's1' },
      })),
      deleteUserSkill: vi.fn(async () => ({
        ok: true as const,
        value: { id: 's1' },
      })),
    });

    const actions = await import('./actions');
    const store = servicesState.userSkills;

    const fdBody = new FormData();
    fdBody.set('id', 's1');
    fdBody.set('body', 'new-body');
    const body = await actions.updateSkillBodyAction({}, fdBody);
    expect(body.ok).toBe(true);
    expect(store.updateUserSkillBody).toHaveBeenCalledWith('u1', 's1', 'new-body');

    const fdDel = new FormData();
    fdDel.set('id', 's1');
    const del = await actions.deleteSkillAction({}, fdDel);
    expect(del.ok).toBe(true);
    expect(store.deleteUserSkill).toHaveBeenCalledWith('u1', 's1');
  });

  it('update details maps invalid_description and not_found without leaking', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      updateUserSkillSummary: vi.fn(async () => ({
        ok: false as const,
        code: 'invalid_description',
        error: 'description too long',
      })),
    });

    const { updateSkillDetailsAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 's1');
    fd.set('name', 'Alpha');
    fd.set('description', 'x'.repeat(20_001));
    const r = await updateSkillDetailsAction({}, fd);
    expect(r.error).toBe('Description must be at most 20,000 characters.');

    skillStore({
      updateUserSkillSummary: vi.fn(async () => ({
        ok: false as const,
        code: 'not_found',
        error: 'skill not found',
      })),
    });
    const actions2 = await import('./actions');
    const fd2 = new FormData();
    fd2.set('id', 'missing');
    fd2.set('name', 'X');
    const r2 = await actions2.updateSkillDetailsAction({}, fd2);
    expect(r2.error).toBe('Skill not found.');
  });
});
