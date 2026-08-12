import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';

/**
 * Phase-1 DI re-point (#440): the route builds services from the composition
 * root (`lib/di`). Route tests mock the **factory shape** (`createProdServices`)
 * rather than the bare module exports, so the mocked methods intercept the
 * call sites as they do in production.
 */
describe('/api/session', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/tenancy/session');
  });

  function mockTenancyOn() {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  }

  function mockHarnessSessions(overrides: Record<string, unknown> = {}) {
    const getHarnessSession =
      (overrides.getHarnessSession as typeof vi.fn) ??
      vi.fn(async () => ({
        ok: false as const,
        code: 'not_found' as const,
        error: 'Session not found.',
      }));
    const putHarnessSession =
      (overrides.putHarnessSession as typeof vi.fn) ??
      vi.fn(async () => ({
        ok: false as const,
        code: 'not_found' as const,
        error: 'Session not found.',
      }));
    const deleteHarnessSession =
      (overrides.deleteHarnessSession as typeof vi.fn) ??
      vi.fn(async () => ({ ok: true as const, value: { deleted: false } }));
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessions: {
          getHarnessSession,
          putHarnessSession,
          deleteHarnessSession,
        },
      }),
      createScriptConnection: vi.fn(),
    }));
    return { getHarnessSession, putHarnessSession, deleteHarnessSession };
  }

  function mockSessionUser(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () =>
        result.ok
          ? result
          : {
              ok: false,
              response: Response.json(
                { error: AUTH_REQUIRED_ERROR },
                { status: 401 },
              ),
            },
      ),
    }));
  }

  it('unauthenticated → 401', async () => {
    vi.resetModules();
    mockTenancyOn();
    mockSessionUser({
      ok: false,
      response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
    });
    mockHarnessSessions();
    const { GET, PUT, DELETE } = await import('./route');
    for (const res of [
      await GET(),
      await PUT(
        new Request('http://localhost/api/session', {
          method: 'PUT',
          body: JSON.stringify({ id: 'sess_x', updatedAt: 1, messages: [] }),
        }),
      ),
      await DELETE(),
    ]) {
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(AUTH_REQUIRED_ERROR);
    }
  });

  it('PUT happy path with opaque sess_… id', async () => {
    vi.resetModules();
    mockTenancyOn();
    const snap = {
      id: 'sess_m1abc_xyz12',
      updatedAt: 1_700_000_000_100,
      messages: [{ id: 'm_1', role: 'user', text: 'hi', at: 1_700_000_000_000 }],
    };
    mockSessionUser({
      ok: true,
      user: { id: 'u1', email: 'a@t.com' },
    });
    const putHarnessSession = vi.fn(async (_uid: string, s: typeof snap) => ({
      ok: true as const,
      value: s,
    }));
    mockHarnessSessions({ putHarnessSession });
    const { PUT } = await import('./route');
    const res = await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        body: JSON.stringify(snap),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('sess_m1abc_xyz12');
    expect(body.messages).toHaveLength(1);
  });

  it('PUT Content-Length over body cap → 413 without full parse', async () => {
    vi.resetModules();
    mockTenancyOn();
    mockSessionUser({ ok: true, user: { id: 'u1' } });
    mockHarnessSessions();
    const { PUT } = await import('./route');
    const { HARNESS_SESSION_MAX_BODY_BYTES } = await import(
      '../../../lib/tenancy/harnessSessions'
    );
    const res = await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        headers: { 'content-length': String(HARNESS_SESSION_MAX_BODY_BYTES + 1) },
        body: '{}',
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BODY_TOO_LARGE');
  });

  it('PUT oversize message bytes → 400', async () => {
    vi.resetModules();
    mockTenancyOn();
    mockSessionUser({ ok: true, user: { id: 'u1' } });
    mockHarnessSessions({ putHarnessSession: vi.fn() });
    const { PUT } = await import('./route');
    const { HARNESS_SESSION_MAX_MSG_BYTES } = await import(
      '../../../lib/tenancy/harnessSessions'
    );
    const text = 'x'.repeat(HARNESS_SESSION_MAX_MSG_BYTES + 1);
    const res = await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        body: JSON.stringify({
          id: 'sess_x',
          updatedAt: 1,
          messages: [{ id: 'm_1', role: 'user', text, at: 1 }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('MESSAGE_TOO_LARGE');
  });

  it('PUT LWW conflict → 409 server body; equal accepted via helper mock', async () => {
    vi.resetModules();
    mockTenancyOn();
    const serverSnap = {
      id: 'sess_server',
      updatedAt: 200,
      messages: [{ id: 'm_s', role: 'user', text: 'server', at: 100 }],
    };
    mockSessionUser({ ok: true, user: { id: 'u1' } });
    const putHarnessSession = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        code: 'conflict' as const,
        error: 'Server has a newer session.',
        value: serverSnap,
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          id: 'sess_eq',
          updatedAt: 200,
          messages: [{ id: 'm_e', role: 'user', text: 'eq', at: 100 }],
        },
      });
    mockHarnessSessions({ putHarnessSession });
    const { PUT } = await import('./route');
    const conflict = await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        body: JSON.stringify({
          id: 'sess_client',
          updatedAt: 100,
          messages: [{ id: 'm_c', role: 'user', text: 'old', at: 50 }],
        }),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual(serverSnap);

    const equal = await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        body: JSON.stringify({
          id: 'sess_eq',
          updatedAt: 200,
          messages: [{ id: 'm_e', role: 'user', text: 'eq', at: 100 }],
        }),
      }),
    );
    expect(equal.status).toBe(200);
    const eqBody = await equal.json();
    expect(eqBody.id).toBe('sess_eq');
  });

  it('cross-user isolation: handlers always pass session user id', async () => {
    vi.resetModules();
    mockTenancyOn();
    const getHarnessSession = vi.fn(async () => ({
      ok: false as const,
      code: 'not_found' as const,
      error: 'Session not found.',
    }));
    const putHarnessSession = vi.fn(async () => ({
      ok: true as const,
      value: { id: 'sess_x', updatedAt: 1, messages: [] },
    }));
    mockSessionUser({ ok: true, user: { id: 'user-a' } });
    mockHarnessSessions({ getHarnessSession, putHarnessSession });
    const { GET, PUT } = await import('./route');
    await GET();
    expect(getHarnessSession).toHaveBeenCalledWith('user-a');

    await PUT(
      new Request('http://localhost/api/session', {
        method: 'PUT',
        body: JSON.stringify({
          id: 'sess_x',
          updatedAt: 1,
          messages: [],
          // attacker-supplied ownership field must be ignored by route
          userId: 'user-b',
        }),
      }),
    );
    expect(putHarnessSession).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ id: 'sess_x' }),
    );
  });

  it('DELETE idempotent 204', async () => {
    vi.resetModules();
    mockTenancyOn();
    const deleteHarnessSession = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: { deleted: true } })
      .mockResolvedValueOnce({ ok: true as const, value: { deleted: false } });
    mockSessionUser({ ok: true, user: { id: 'u1' } });
    mockHarnessSessions({ deleteHarnessSession });
    const { DELETE } = await import('./route');
    const r1 = await DELETE();
    const r2 = await DELETE();
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(204);
    expect(deleteHarnessSession).toHaveBeenCalledTimes(2);
  });
});
