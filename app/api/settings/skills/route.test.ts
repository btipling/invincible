import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Review #525 skill-wire plan — measured body routes:
 *   POST /api/settings/skills (create-with-body, multipart)
 *   GET/PUT /api/settings/skills/:id/body (raw body carry)
 *
 * A skill body is NOT carried by a server action (1 MB default `bodySizeLimit`
 * would reject a 4 MiB body). These routes enforce a content-length fast-path + an
 * authoritative byte check against `SKILL_BODY_MAX_BYTES`, and the wire is raw (no
 * JSON string escaping) so a 4 MiB body keeps genuine headroom under the 4.5 MB
 * Function ceiling.
 */
import { SKILL_BODY_MAX_BYTES } from '../../../../lib/tenancy/userSkills';

const FOUR_MIB = 4 * 1024 * 1024;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../../../lib/di');
  vi.doUnmock('../../../../lib/tenancy/session');
});

function mockDi(userSkills: Record<string, unknown>) {
  vi.doMock('../../../../lib/di', () => ({
    createProdServices: () => ({ userSkills }),
    createScriptConnection: vi.fn(),
  }));
}

function mockSession(
  result:
    | { ok: true; user: { id: string } }
    | { ok: false; response: Response },
) {
  vi.doMock('../../../../lib/tenancy/session', () => ({
    requireSessionUser: vi.fn(async () => result),
  }));
}

function mockAuthed() {
  mockSession({ ok: true, user: { id: 'u1' } });
}

describe('POST /api/settings/skills (create-with-body, measured route)', () => {
  it('unauthenticated → 401', async () => {
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockDi({});
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/settings/skills', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  it('creates a skill from multipart name/description/body (raw wire)', async () => {
    const createUserSkill = vi.fn(
      async (input: { userId: string; name: string; slug: string; body: string; description?: string }) =>
        ({ ok: true, value: { id: 'sk1' } }),
    );
    mockAuthed();
    mockDi({ createUserSkill });
    const { POST } = await import('./route');

    const form = new FormData();
    form.set('name', 'Create plan');
    form.set('description', 'Writes a plan issue.');
    form.set('body', '# Playbook\n- step one');
    const res = await POST(
      new Request('http://localhost/api/settings/skills', {
        method: 'POST',
        body: form,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body).toEqual({ ok: true, id: 'sk1' });
    expect(createUserSkill).toHaveBeenCalledTimes(1);
    const arg = createUserSkill.mock.calls[0]![0];
    // Multipart CRLF-normalizes line endings, so the decoded raw body carries \r\n.
    expect(arg).toMatchObject({
      userId: 'u1',
      name: 'Create plan',
      body: '# Playbook\r\n- step one',
    });
    expect(arg.slug).toMatch(/^create_plan/);
  });

  it('dedupes a colliding slug with _N suffix', async () => {
    const createUserSkill = vi.fn(
      async (input: { slug: string }) =>
        input.slug === 'create_plan'
          ? { ok: false, code: 'duplicate_slug', error: 'dup' }
          : { ok: true, value: { id: 'sk2' } },
    );
    mockAuthed();
    mockDi({ createUserSkill });
    const { POST } = await import('./route');
    const form = new FormData();
    form.set('name', 'Create plan');
    form.set('body', 'a playbook');
    const res = await POST(
      new Request('http://localhost/api/settings/skills', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(201);
    expect(createUserSkill).toHaveBeenCalledTimes(2);
    expect(createUserSkill.mock.calls[1]![0].slug).toBe('create_plan_2');
  });

  it('rejects an over-cap body (authoritative byte check) → 413', async () => {
    const createUserSkill = vi.fn();
    mockAuthed();
    mockDi({ createUserSkill });
    const { POST } = await import('./route');
    const form = new FormData();
    form.set('name', 'Big');
    form.set('body', 'x'.repeat(FOUR_MIB + 1));
    const res = await POST(
      new Request('http://localhost/api/settings/skills', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(413);
    expect(createUserSkill).not.toHaveBeenCalled();
  });

  it('rejects an over-cap declared content-length (fast-path) → 413', async () => {
    const createUserSkill = vi.fn();
    mockAuthed();
    mockDi({ createUserSkill });
    const { POST } = await import('./route');
    const req = new Request('http://localhost/api/settings/skills', { method: 'POST' });
    req.headers.set('content-length', String(FOUR_MIB + 1024 * 1024));
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(createUserSkill).not.toHaveBeenCalled();
  });

  it('surfaces a store error as its mapped status', async () => {
    const createUserSkill = vi.fn(async () => ({
      ok: false,
      code: 'invalid_name',
      error: 'name must be 1–200 chars',
    }));
    mockAuthed();
    mockDi({ createUserSkill });
    const { POST } = await import('./route');
    const form = new FormData();
    form.set('name', '');
    form.set('body', 'a');
    const res = await POST(
      new Request('http://localhost/api/settings/skills', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET/PUT /api/settings/skills/:id/body (raw body carry)', () => {
  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it('GET returns the owner body as raw text (no JSON escaping)', async () => {
    const listUserSkills = vi.fn(async () => ({
      ok: true,
      value: [{ id: 'sk1', name: 'Create plan', slug: 'create_plan', description: '', updatedAt: new Date() }],
    }));
    const getSkillBySlug = vi.fn(async () => ({
      ok: true,
      value: { id: 'sk1', body: '# Playbook\n"quoted" \\ backslash' },
    }));
    mockAuthed();
    mockDi({ listUserSkills, getSkillBySlug });
    const { GET } = await import('./[id]/body/route');
    const res = await GET(new Request('http://localhost/api/settings/skills/sk1/body'), ctx('sk1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    // RAW wire: quotes/backslashes are NOT doubled by a JSON string wrapper.
    expect(await res.text()).toBe('# Playbook\n"quoted" \\ backslash');
  });

  it('GET returns 404 for another-user / missing skill (no existence leak)', async () => {
    const listUserSkills = vi.fn(async () => ({ ok: true, value: [] }));
    mockAuthed();
    mockDi({ listUserSkills });
    const { GET } = await import('./[id]/body/route');
    const res = await GET(new Request('http://localhost/api/settings/skills/missing/body'), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('PUT replaces the raw body; an over-cap body → 413 with no store call', async () => {
    const updateUserSkillBody = vi.fn(
      async (_userId: string, _id: string, _body: string) =>
        ({ ok: true, value: { id: 'sk1' } }),
    );
    mockAuthed();
    mockDi({ updateUserSkillBody });
    const { PUT } = await import('./[id]/body/route');
    // In-bounds raw body.
    const ok = await PUT(
      new Request('http://localhost/api/settings/skills/sk1/body', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: '# new body\nplain text',
      }),
      ctx('sk1'),
    );
    expect(ok.status).toBe(200);
    expect(updateUserSkillBody).toHaveBeenCalledTimes(1);
    expect(updateUserSkillBody.mock.calls[0]![2]).toBe('# new body\nplain text');

    // Over-cap → 413 before the store.
    const over = await PUT(
      new Request('http://localhost/api/settings/skills/sk1/body', {
        method: 'PUT',
        body: 'x'.repeat(FOUR_MIB + 1),
      }),
      ctx('sk1'),
    );
    expect(over.status).toBe(413);
    expect(updateUserSkillBody).toHaveBeenCalledTimes(1);
  });

  it('PUT over-cap declared content-length (fast-path) → 413 without buffering', async () => {
    const updateUserSkillBody = vi.fn();
    mockAuthed();
    mockDi({ updateUserSkillBody });
    const { PUT } = await import('./[id]/body/route');
    const req = new Request('http://localhost/api/settings/skills/sk1/body', { method: 'PUT' });
    req.headers.set('content-length', String(FOUR_MIB + 1));
    const res = await PUT(req, ctx('sk1'));
    expect(res.status).toBe(413);
    expect(updateUserSkillBody).not.toHaveBeenCalled();
  });
});

describe('skill-body wire-math lock (review #525 plan)', () => {
  // Function ceiling: Vercel rejects a >4.5 MB request/response (413
  // FUNCTION_PAYLOAD_TOO_LARGE / FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE).
  const FUNCTION_CEILING_BYTES = 4.5 * 1024 * 1024;

  it('locks the body cap at 4 MiB (generous #514 budget, not lowered)', () => {
    expect(SKILL_BODY_MAX_BYTES).toBe(FOUR_MIB);
  });

  it('body + max multipart/boundary overhead stays under the 4.5 MB Function ceiling', async () => {
    // The wire module imports lib/tenancy/session (→ next-auth), so load it
    // dynamically AFTER registering the session mock, like the route tests above.
    mockAuthed();
    const { SKILL_BODY_WIRE_OVERHEAD_BYTES } = await import('./wire');
    expect(SKILL_BODY_WIRE_OVERHEAD_BYTES).toBe(64 * 1024);
    // The measured routes enforce SKILL_BODY_MAX_BYTES on the decoded body and
    // the content-length fast-path allows up to +SKILL_BODY_WIRE_OVERHEAD_BYTES
    // for multipart boundary/part headers. Even at the absolute wire maximum the
    // request must stay < 4.5 MB so Vercel never rejects below what we advertise.
    expect(SKILL_BODY_MAX_BYTES).toBeLessThan(FUNCTION_CEILING_BYTES);
    expect(SKILL_BODY_MAX_BYTES + SKILL_BODY_WIRE_OVERHEAD_BYTES).toBeLessThan(
      FUNCTION_CEILING_BYTES,
    );
  });
});
