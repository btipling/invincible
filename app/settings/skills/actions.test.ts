import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Node-env server-action unit tests (no RTL/jsdom — the repo runs vitest in
 * `environment: 'node'`; sibling Settings pages test actions the same way with
 * mocked DI + auth). These exercise the small-CRUD skills server actions against
 * mocked store calls.
 *
 * Review #525 skill-wire plan: only the small CRUD (name/description edit via
 * `updateSkillDetailsAction`, delete via `deleteSkillAction`) stays on server
 * actions. The 4 MiB body travels measured route handlers (`POST /api/settings/skills`
 * create-with-body, `PUT /api/settings/skills/:id/body` replace-body) — tested in
 * `app/api/settings/skills/route.test.ts`, not here.
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
      updateUserSkillSummary: vi.fn(),
      deleteUserSkill: vi.fn(),
      ...overrides,
    };
  }

  it('details edit rejects unauthenticated and never calls the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth(null);
    skillStore();

    const { updateSkillDetailsAction } = await import('./actions');
    const fd = new FormData();
    fd.set('id', 's1');
    fd.set('name', 'Alpha');
    const r = await updateSkillDetailsAction({}, fd);
    expect(r.error).toBe('Authentication required.');
    expect(servicesState.userSkills.updateUserSkillSummary).not.toHaveBeenCalled();
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

  it('delete routes through the store', async () => {
    tenancyOn();
    vi.resetModules();
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
    mockDi();
    mockAuth({ id: 'u1' });
    mockMembership({ ok: true, tenantId: 't1', role: 'owner' });
    skillStore({
      deleteUserSkill: vi.fn(async () => ({
        ok: true as const,
        value: { id: 's1' },
      })),
    });

    const { deleteSkillAction } = await import('./actions');
    const fdDel = new FormData();
    fdDel.set('id', 's1');
    const del = await deleteSkillAction({}, fdDel);
    expect(del.ok).toBe(true);
    expect(servicesState.userSkills.deleteUserSkill).toHaveBeenCalledWith('u1', 's1');
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
    fd.set('description', 'x'.repeat(501));
    const r = await updateSkillDetailsAction({}, fd);
    expect(r.error).toBe('Description must be at most 2000 characters.');

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
