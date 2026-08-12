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
    vi.doUnmock('../../../../../../lib/di');
    vi.doUnmock('../../../../../../lib/tenancy/identity');
  });

  function mockScim(slice: {
    handleScimDeleteUser?: (id: string) => unknown;
    handleScimGetUser?: (req: Request, id: string) => unknown;
    handleScimPutUser?: (req: Request, id: string) => unknown;
    handleScimPatchUser?: (req: Request, id: string) => unknown;
  }) {
    vi.doMock('../../../../../../lib/di', () => ({
      createProdServices: () => ({
        scim: {
          handleScimListUsers: vi.fn(),
          handleScimCreateUser: vi.fn(),
          handleScimGetUser: vi.fn(),
          handleScimPutUser: vi.fn(),
          handleScimPatchUser: vi.fn(),
          handleScimDeleteUser: vi.fn(),
          ...slice,
        },
      }),
      createScriptConnection: vi.fn(),
    }));
  }

  it('DELETE suspends SCIM user', async () => {
    process.env = { ...originalEnv, ...tenancyOn };
    const handleScimDeleteUser = vi.fn(async () => new Response(null, { status: 204 }));
    mockScim({ handleScimDeleteUser });
    const { DELETE } = await import('./route');
    const res = await DELETE(
      new Request('http://localhost/api/scim/v2/Users/' + scimUser.id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer scim-tok' },
      }),
      { params: Promise.resolve({ id: scimUser.id }) },
    );
    expect(res.status).toBe(204);
    expect(handleScimDeleteUser).toHaveBeenCalledWith(scimUser.id);
  });

  it('GET non-SCIM returns 404', async () => {
    process.env = { ...originalEnv, ...tenancyOn };
    const handleScimGetUser = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'User not found' }), { status: 404 }),
    );
    mockScim({ handleScimGetUser });
    const { GET } = await import('./route');
    const res = await GET(
      new Request('http://localhost/api/scim/v2/Users/nope', {
        headers: { Authorization: 'Bearer scim-tok' },
      }),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });

  it('PUT prefers userName over emails', async () => {
    process.env = { ...originalEnv, ...tenancyOn };
    const handleScimPutUser = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: scimUser.id, userName: 'a@example.com', active: true }),
        { status: 200 },
      ),
    );
    mockScim({ handleScimPutUser });
    const { PUT } = await import('./route');
    const res = await PUT(
      new Request('http://localhost/api/scim/v2/Users/' + scimUser.id, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer scim-tok',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userName: 'a@example.com',
          emails: [{ value: 'b@example.com', primary: true }],
        }),
      }),
      { params: Promise.resolve({ id: scimUser.id }) },
    );
    expect(res.status).toBe(200);
    expect(handleScimPutUser).toHaveBeenCalledWith(
      expect.any(Request),
      scimUser.id,
    );
  });
});
