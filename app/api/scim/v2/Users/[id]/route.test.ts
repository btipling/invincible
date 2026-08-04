import { afterEach, describe, expect, it, vi } from 'vitest';

const tenancyOn = {
  DATABASE_URL: 'postgres://localhost/db',
  AUTH_SECRET: 'secret-secret-secret-secret-secret',
  CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  SCIM_BEARER_TOKEN: 'scim-tok',
};

const scimUser = {
  id: '33333333-3333-3333-3333-333333333333',
  email: 'del@example.com',
  name: 'Del',
  status: 'active',
  image: null,
  emailVerified: null,
  passwordHash: null,
  idpSubject: null,
  provisionSource: 'scim',
  scimExternalId: 'del-ext',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('SCIM /api/scim/v2/Users/:id', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('DELETE suspends SCIM user', async () => {
    process.env = { ...originalEnv, ...tenancyOn };
    const suspend = vi.fn(async () => ({ ...scimUser, status: 'suspended' }));
    vi.doMock('../../../../../../lib/tenancy/identity', async () => {
      const actual = await vi.importActual<
        typeof import('../../../../../../lib/tenancy/identity')
      >('../../../../../../lib/tenancy/identity');
      return {
        ...actual,
        getScimUserById: vi.fn(async () => scimUser),
        scimSuspendUser: suspend,
      };
    });
    const { DELETE } = await import('./route');
    const res = await DELETE(
      new Request('http://localhost/api/scim/v2/Users/' + scimUser.id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer scim-tok' },
      }),
      { params: Promise.resolve({ id: scimUser.id }) },
    );
    expect(res.status).toBe(204);
    expect(suspend).toHaveBeenCalled();
  });

  it('GET non-SCIM returns 404', async () => {
    process.env = { ...originalEnv, ...tenancyOn };
    vi.doMock('../../../../../../lib/tenancy/identity', async () => {
      const actual = await vi.importActual<
        typeof import('../../../../../../lib/tenancy/identity')
      >('../../../../../../lib/tenancy/identity');
      return {
        ...actual,
        getScimUserById: vi.fn(async () => null),
      };
    });
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/scim/v2/Users/nope', {
        headers: { Authorization: 'Bearer scim-tok' },
      }),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });
});
