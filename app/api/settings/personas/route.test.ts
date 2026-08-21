import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan #726 (source #534) — persona version history / rollback endpoints:
 *   GET /api/settings/personas/:id/versions (list summaries, no body)
 *   GET /api/settings/personas/:id/versions/:versionId (single version body)
 *   POST /api/settings/personas/:id/rollback (restore + new version row)
 *
 * Gate = the REST `requireUserId` (mirrors the skills REST surface, NOT the
 * persona server-action `requireSettingsSession`). Pattern matches the shipped
 * skill version route tests (review finding #3).
 */

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../../../lib/di');
  vi.doUnmock('../../../../lib/tenancy/session');
});

function mockDi(userPersonas: Record<string, unknown>) {
  vi.doMock('../../../../lib/di', () => ({
    createProdServices: () => ({ userPersonas }),
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

describe('GET /api/settings/personas/:id/versions (list summaries)', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('unauthenticated → 401', async () => {
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockDi({});
    const { GET } = await import('./[id]/versions/route');
    const res = await GET(new Request('http://localhost/api/versions'), ctx('p1'));
    expect(res.status).toBe(401);
  });

  it('happy: returns newest-first summaries', async () => {
    const listPersonaVersions = vi.fn(async () => ({
      ok: true,
      value: [{ id: 'ver2', label: '', createdAt: new Date() }],
    }));
    mockAuthed();
    mockDi({ listPersonaVersions });
    const { GET } = await import('./[id]/versions/route');
    const res = await GET(new Request('http://localhost/api/versions'), ctx('p1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; versions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.versions).toHaveLength(1);
    expect(listPersonaVersions).toHaveBeenCalledWith('u1', 'p1');
  });

  it('missing persona id → 400', async () => {
    mockAuthed();
    mockDi({});
    const { GET } = await import('./[id]/versions/route');
    const res = await GET(new Request('http://localhost/api/versions'), ctx(''));
    expect(res.status).toBe(400);
  });

  it('store unavailable → 503', async () => {
    mockAuthed();
    mockDi({
      listPersonaVersions: vi.fn(async () => ({
        ok: false,
        code: 'unavailable',
        error: 'user_persona_versions unavailable',
      })),
    });
    const { GET } = await import('./[id]/versions/route');
    const res = await GET(new Request('http://localhost/api/versions'), ctx('p1'));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/settings/personas/:id/versions/:versionId (single version body)', () => {
  const ctx = (id: string, versionId: string) =>
    ({ params: Promise.resolve({ id, versionId }) });

  it('unauthenticated → 401', async () => {
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockDi({});
    const { GET } = await import('./[id]/versions/[versionId]/route');
    const res = await GET(
      new Request('http://localhost/api/versions/ver1'),
      ctx('p1', 'ver1'),
    );
    expect(res.status).toBe(401);
  });

  it('not-owner / missing version → 404 (no existence leak)', async () => {
    const getPersonaVersion = vi.fn(async () => ({ ok: true, value: null }));
    mockAuthed();
    mockDi({ getPersonaVersion });
    const { GET } = await import('./[id]/versions/[versionId]/route');
    const res = await GET(
      new Request('http://localhost/api/versions/ver1'),
      ctx('p1', 'ver1'),
    );
    expect(res.status).toBe(404);
  });

  it('happy: returns the version body as raw text (un-escaped wire)', async () => {
    const getPersonaVersion = vi.fn(async () => ({
      ok: true,
      value: { id: 'ver1', label: '', body: '# body\n"quotes" \\ slash', createdAt: new Date() },
    }));
    mockAuthed();
    mockDi({ getPersonaVersion });
    const { GET } = await import('./[id]/versions/[versionId]/route');
    const res = await GET(
      new Request('http://localhost/api/versions/ver1'),
      ctx('p1', 'ver1'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('# body\n"quotes" \\ slash');
  });
});

describe('POST /api/settings/personas/:id/rollback', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it('unauthenticated → 401', async () => {
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockDi({});
    const { POST } = await import('./[id]/rollback/route');
    const res = await POST(
      new Request('http://localhost/api/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: 'ver1' }),
      }),
      ctx('p1'),
    );
    expect(res.status).toBe(401);
  });

  it('missing versionId → 400', async () => {
    mockAuthed();
    mockDi({});
    const { POST } = await import('./[id]/rollback/route');
    const res = await POST(
      new Request('http://localhost/api/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ctx('p1'),
    );
    expect(res.status).toBe(400);
  });

  it('not-owner persona → 404 (store not_found mapped)', async () => {
    const rollbackPersona = vi.fn(async () => ({
      ok: false,
      code: 'not_found',
      error: 'persona not found',
    }));
    mockAuthed();
    mockDi({ rollbackPersona });
    const { POST } = await import('./[id]/rollback/route');
    const res = await POST(
      new Request('http://localhost/api/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: 'ver1' }),
      }),
      ctx('p1'),
    );
    expect(res.status).toBe(404);
  });

  it('at the version cap → 400', async () => {
    const rollbackPersona = vi.fn(async () => ({
      ok: false,
      code: 'invalid_body',
      error: 'version limit reached (100) — delete the persona or raise the cap',
    }));
    mockAuthed();
    mockDi({ rollbackPersona });
    const { POST } = await import('./[id]/rollback/route');
    const res = await POST(
      new Request('http://localhost/api/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: 'ver1' }),
      }),
      ctx('p1'),
    );
    expect(res.status).toBe(400);
  });

  it('happy: rolls back and returns ok + id', async () => {
    const rollbackPersona = vi.fn(async () => ({ ok: true, value: { id: 'p1' } }));
    mockAuthed();
    mockDi({ rollbackPersona });
    const { POST } = await import('./[id]/rollback/route');
    const res = await POST(
      new Request('http://localhost/api/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: 'ver1' }),
      }),
      ctx('p1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body).toEqual({ ok: true, id: 'p1' });
    expect(rollbackPersona).toHaveBeenCalledWith('u1', 'p1', 'ver1');
  });
});
