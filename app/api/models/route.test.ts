import { afterEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/models', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/tenancy/enabled');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/tenancy/resolveInference');
    vi.doUnmock('../../../lib/model');
  });

  it('tenancy off returns single env model (fail-closed session required)', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => false,
    }));
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true,
        user: { id: 'u1', email: 'a@t.com' },
      })),
    }));
    vi.doMock('../../../lib/model', () => ({
      resolveModelId: () => 'xai/grok-test',
    }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([{ id: 'xai/grok-test', label: 'grok-test' }]);
  });

  it('unauth (even when tenancy off) → 401', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => false,
    }));
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false,
        response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
      })),
    }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('tenancy on unauthenticated → 401', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false,
        response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
      })),
    }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('tenancy on returns grant-filtered catalog', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/enabled', () => ({
      tenancyEnabled: () => true,
    }));
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true,
        user: { id: 'u1', email: 'a@t.com' },
      })),
    }));
    vi.doMock('../../../lib/tenancy/resolveInference', () => ({
      listModelsForUser: vi.fn(async () => ['anthropic/claude-z', 'anthropic/claude-a']),
    }));
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'anthropic/claude-z', label: 'claude-z' },
      { id: 'anthropic/claude-a', label: 'claude-a' },
    ]);
  });
});
