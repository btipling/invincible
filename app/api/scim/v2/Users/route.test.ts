import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScimHandlers,
  type ScimIdentity,
} from '../../../../../lib/tenancy/scimHandlers';
import { IdentityError } from '../../../../../lib/tenancy/identity';

const tenancyOn = {
  DATABASE_URL: 'postgres://localhost/db',
  AUTH_SECRET: 'secret-secret-secret-secret-secret',
  CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

describe('SCIM /api/scim/v2/Users', () => {
  const originalEnv = { ...process.env };

  /**
   * Build a fake identity whose real I/O methods are spies (so schema validation
   * in the real scim handlers rejects *before* identity I/O is ever reached),
   * then wire the DI scim slice. `slice` overrides individual handler outputs;
   * `identity` overrides identity I/O methods.
   */
  function makeMockScim(slice?: Record<string, unknown>, identity?: Partial<ScimIdentity>) {
    const fakeIdentity: ScimIdentity = {
      getScimUserById: vi.fn(async () => null),
      listScimUsers: vi.fn(async () => ({ users: [], totalResults: 0 })),
      scimCreateUser: vi.fn(async () => {
        throw new Error('identity I/O not reached');
      }),
      scimSuspendUser: vi.fn(async () => {
        throw new Error('identity I/O not reached');
      }),
      scimUpdateUser: vi.fn(async () => {
        throw new Error('identity I/O not reached');
      }),
      IdentityError,
      ...identity,
    };
    const realScim = createScimHandlers(fakeIdentity);
    const scim = {
      handleScimListUsers: realScim.handleScimListUsers,
      handleScimCreateUser: realScim.handleScimCreateUser,
      handleScimGetUser: realScim.handleScimGetUser,
      handleScimPutUser: realScim.handleScimPutUser,
      handleScimPatchUser: realScim.handleScimPatchUser,
      handleScimDeleteUser: realScim.handleScimDeleteUser,
      ...slice,
    };
    vi.doMock('../../../../../lib/di', () => ({
      createProdServices: () => ({ scim }),
      createScriptConnection: vi.fn(),
    }));
    return { identity: fakeIdentity, scim };
  }

  function mockScim(slice?: Record<string, unknown>) {
    makeMockScim(slice);
  }

  function clearTenancy() {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.SCIM_BEARER_TOKEN;
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('../../../../../lib/di');
    vi.doUnmock('../../../../../lib/tenancy/identity');
  });

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

  it('lists users with bearer (mocked scim)', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const handleScimListUsers = vi.fn(async () =>
      new Response(
        JSON.stringify({
          totalResults: 1,
          Resources: [{ id: 'x', userName: 's@example.com', active: true }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/scim+json' } },
      ),
    );
    mockScim({ handleScimListUsers });
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
    mockScim({});
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/scim/v2/Users?count=101', {
        headers: { Authorization: 'Bearer scim-tok' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates user with bearer (mocked scim) and prefers userName', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    const createdId = '44444444-4444-4444-4444-444444444444';
    const handleScimCreateUser = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: createdId, userName: 'new@example.com', active: true }),
        {
          status: 201,
          headers: {
            'Content-Type': 'application/scim+json',
            Location: `http://localhost/api/scim/v2/Users/Users/${createdId}`,
          },
        },
      ),
    );
    mockScim({ handleScimCreateUser });
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
    expect(res.headers.get('Location')).toContain(createdId);
    expect(handleScimCreateUser).toHaveBeenCalled();
    const body = (await res.json()) as { userName: string };
    expect(body.userName).toBe('new@example.com');
  });

  it('rejects oversized displayName before handler', async () => {
    clearTenancy();
    Object.assign(process.env, tenancyOn, { SCIM_BEARER_TOKEN: 'scim-tok' });
    // No slice override → the real handler runs its schema validation, so the fake
    // identity's scimCreateUser must NOT be reached.
    const { identity } = makeMockScim();
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
    expect(identity.scimCreateUser).not.toHaveBeenCalled();
  });
});
