import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from './errors';

describe('requireSessionUser', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unmock('../../auth');
  });

  it('401 when no session user id', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => null),
    }));
    const { requireSessionUser } = await import('./session');
    const result = await requireSessionUser();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(401);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('returns session user when auth has id', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    vi.doMock('../../auth', () => ({
      auth: vi.fn(async () => ({
        user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      })),
    }));
    const { requireSessionUser } = await import('./session');
    const result = await requireSessionUser();
    expect(result).toEqual({
      ok: true,
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
    });
  });
});
