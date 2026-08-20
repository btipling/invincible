import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/settings/skills/[id]/always-on — toggle is_always_on (plan #720 phase 2).
 * L6 test coverage (adversarial-review #722): 401, 404, 200 toggle on/off, 400 cap.
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../../../../../lib/di');
  vi.doUnmock('../../../../../../lib/tenancy/session');
});

function mockDi(userSkills: Record<string, unknown>) {
  vi.doMock('../../../../../../lib/di', () => ({
    createProdServices: () => ({ userSkills }),
  }));
}

function mockSession(
  result:
    | { ok: true; user: { id: string } }
    | { ok: false; response: Response },
) {
  vi.doMock('../../../../../../lib/tenancy/session', () => ({
    requireSessionUser: vi.fn(async () => result),
  }));
}

function mockAuthed() {
  mockSession({ ok: true, user: { id: 'u1' } });
}

describe('POST /api/settings/skills/[id]/always-on', () => {
  it('unauthenticated → 401', async () => {
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockDi({});
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: true }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('404 for bogus skill id', async () => {
    mockAuthed();
    const setAlwaysOn = vi.fn().mockResolvedValue({
      ok: false,
      code: 'not_found',
      error: 'skill not found',
    });
    mockDi({ setAlwaysOn });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills/bogus/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: true }),
      }),
      { params: Promise.resolve({ id: 'bogus' }) },
    );
    expect(res.status).toBe(404);
  });

  it('400 when { value: boolean } contract is violated', async () => {
    mockAuthed();
    mockDi({});
    const { POST } = await import('./route');

    // Missing value key
    const res1 = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res1.status).toBe(400);

    // value is not a boolean
    const res2 = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'true' }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res2.status).toBe(400);

    // Invalid JSON body
    const res3 = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res3.status).toBe(400);
  });

  it('200 toggles on (true) returns { ok: true, id, isAlwaysOn: true }', async () => {
    mockAuthed();
    const setAlwaysOn = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 's1' },
    });
    mockDi({ setAlwaysOn });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: true }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, id: 's1', isAlwaysOn: true });
    expect(setAlwaysOn).toHaveBeenCalledWith('u1', 's1', true);
  });

  it('200 toggles off (false) returns { ok: true, id, isAlwaysOn: false }', async () => {
    mockAuthed();
    const setAlwaysOn = vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 's1' },
    });
    mockDi({ setAlwaysOn });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: false }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, id: 's1', isAlwaysOn: false });
    expect(setAlwaysOn).toHaveBeenCalledWith('u1', 's1', false);
  });

  it('400 at cap — always-on limit reached', async () => {
    mockAuthed();
    const setAlwaysOn = vi.fn().mockResolvedValue({
      ok: false,
      code: 'limit_reached',
      error: 'always-on limit reached (8)',
    });
    mockDi({ setAlwaysOn });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills/s1/always-on', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: true }),
      }),
      { params: Promise.resolve({ id: 's1' }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('always-on limit reached');
  });
});
