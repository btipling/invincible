import { afterEach, describe, expect, it, vi } from 'vitest';

const tenancyOn = {
  DATABASE_URL: 'postgres://localhost/db',
  AUTH_SECRET: 'secret-secret-secret-secret-secret',
  CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('SCIM /api/scim/v2/Users', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function clearTenancy() {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.SCIM_BEARER_TOKEN;
  }

  it('returns 404 when SCIM not configured', async () => {
    clearTenancy();
    const { GET, POST } = await import('./route');
    const res = await GET(new Request('http://localhost/api/scim/v2/Users'));
    expect(res.status).toBe(404);
    const post = await POST(
      new Request('http://localhost/api/scim/v2/Users', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(post.status).toBe(404);
  });

  it('returns 401 without bearer when configured', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const { GET } = await import('./route');
    const res = await GET(new Request('http://localhost/api/scim/v2/Users'));
    expect(res.status).toBe(401);
  });

  it('lists users with bearer (mocked identity)', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    vi.doMock('../../../../../lib/tenancy/identity', async () => {
      const actual = await vi.importActual<typeof import('../../../../../lib/tenancy/identity')>(
        '../../../../../lib/tenancy/identity',
      );
      return {
        ...actual,
        listScimUsers: vi.fn(async () => ({
          users: [
            {
              id: '22222222-2222-2222-2222-222222222222',
              email: 's@example.com',
              name: 'S',
              status: 'active',
              image: null,
              emailVerified: null,
              passwordHash: null,
              idpSubject: null,
              provisionSource: 'scim',
              scimExternalId: 'e',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          totalResults: 1,
        })),
      };
    });
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/scim/v2/Users?count=10', {
        headers: { Authorization: 'Bearer scim-tok' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalResults: number;
      Resources: Array<{ userName: string }>;
    };
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]?.userName).toBe('s@example.com');
  });

  it('rejects count > 100', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/scim/v2/Users?count=101', {
        headers: { Authorization: 'Bearer scim-tok' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates user with bearer (mocked identity) and prefers userName', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const created = {
      id: '44444444-4444-4444-4444-444444444444',
      email: 'new@example.com',
      name: 'New',
      status: 'active',
      image: null,
      emailVerified: null,
      passwordHash: null,
      idpSubject: null,
      provisionSource: 'scim',
      scimExternalId: 'ext-new',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const createFn = vi.fn(async () => created);
    vi.doMock('../../../../../lib/tenancy/identity', async () => {
      const actual = await vi.importActual<typeof import('../../../../../lib/tenancy/identity')>(
        '../../../../../lib/tenancy/identity',
      );
      return {
        ...actual,
        scimCreateUser: createFn,
      };
    });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/scim/v2/Users', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer scim-tok',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userName: 'new@example.com',
          emails: [{ value: 'other@example.com', primary: true }],
          displayName: 'New',
          externalId: 'ext-new',
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toContain(created.id);
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com' }),
    );
    const body = (await res.json()) as { userName: string };
    expect(body.userName).toBe('new@example.com');
  });

  it('rejects oversized displayName', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/scim/v2/Users', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer scim-tok',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userName: 'big@example.com',
          displayName: 'x'.repeat(300),
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
