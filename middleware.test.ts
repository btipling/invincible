import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from './lib/tenancy/errors';

/**
 * Middleware is edge-oriented; we unit-test behavior via dynamic import
 * with env + getToken mocked.
 */
describe('middleware tenancy gate', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unmock('next-auth/jwt');
  });

  async function loadMw() {
    return import('./middleware');
  }

  it('passes through when tenancy off', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    const { middleware } = await loadMw();
    const res = await middleware(
      new Request('http://localhost/api/agent', { method: 'POST' }) as never,
    );
    // next() returns a NextResponse with no redirect/401
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('401 JSON on unauth API when tenancy on', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-secret-value-for-jwt-middleware!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    vi.doMock('next-auth/jwt', () => ({
      getToken: vi.fn(async () => null),
    }));
    const { middleware } = await loadMw();
    const res = await middleware(
      new Request('http://localhost/api/agent', { method: 'POST' }) as never,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('redirects unauth pages to /login when tenancy on', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-secret-value-for-jwt-middleware!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    vi.doMock('next-auth/jwt', () => ({
      getToken: vi.fn(async () => null),
    }));
    const { middleware } = await loadMw();
    const res = await middleware(
      new Request('http://localhost/harness') as never,
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/login');
    expect(loc).toContain('callbackUrl');
  });

  it('allows request when JWT sub present', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-secret-value-for-jwt-middleware!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    vi.doMock('next-auth/jwt', () => ({
      getToken: vi.fn(async () => ({ sub: 'user-uuid' })),
    }));
    const { middleware } = await loadMw();
    const res = await middleware(
      new Request('http://localhost/api/chat', { method: 'POST' }) as never,
    );
    expect(res.status).toBe(200);
  });

  it('passes secureCookie:true to getToken on HTTPS (Vercel prod cookie name)', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-secret-value-for-jwt-middleware!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    const getToken = vi.fn(
      async (_opts?: { secureCookie?: boolean }) => ({ sub: 'user-uuid' }),
    );
    vi.doMock('next-auth/jwt', () => ({ getToken }));
    const { middleware } = await loadMw();
    const req = new Request('https://invincible-dun-ten.vercel.app/harness', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    await middleware(req as never);
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({ secureCookie: true }),
    );
  });

  it('passes secureCookie:false on plain http localhost', async () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.AUTH_SECRET = 'test-secret-value-for-jwt-middleware!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'key-material';
    vi.resetModules();
    const getToken = vi.fn(
      async (_opts?: { secureCookie?: boolean }) => ({ sub: 'user-uuid' }),
    );
    vi.doMock('next-auth/jwt', () => ({ getToken }));
    const { middleware } = await loadMw();
    await middleware(new Request('http://localhost/harness') as never);
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({ secureCookie: false }),
    );
  });
});

describe('useSecureAuthCookie', () => {
  it('detects https URL and x-forwarded-proto', async () => {
    vi.resetModules();
    const { useSecureAuthCookie } = await import('./middleware');
    expect(
      useSecureAuthCookie(
        new Request('https://example.com/harness') as never,
      ),
    ).toBe(true);
    expect(
      useSecureAuthCookie(
        new Request('http://localhost/harness', {
          headers: { 'x-forwarded-proto': 'https' },
        }) as never,
      ),
    ).toBe(true);
    expect(
      useSecureAuthCookie(new Request('http://localhost/harness') as never),
    ).toBe(false);
  });
});
