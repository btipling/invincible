import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { authenticateCredentials } from './authenticate';
import { FIXTURE_LOGIN, FIXTURE_PASSWORD_HASH } from './test/fixtures';

describe('authenticateCredentials', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    ({ client, db } = await createTenancyTestDb());

    // Precomputed cost-12 fixture hash (setup runs zero real bcrypt hashes);
    // `authenticateCredentials` still exercises the real bcrypt.compare against
    // `FIXTURE_PASSWORD_HASH` of `FIXTURE_LOGIN`.
    await db.insert(schema.users).values([
      {
        email: 'active@example.com',
        name: 'Active',
        status: 'active',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'credentials',
      },
      {
        email: 'inactive@example.com',
        name: 'Inactive',
        status: 'inactive',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'credentials',
      },
      {
        email: 'suspended@example.com',
        name: 'Suspended',
        status: 'suspended',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'credentials',
      },
      {
        email: 'nohash@example.com',
        name: 'NoHash',
        status: 'active',
        passwordHash: null,
        provisionSource: 'oidc',
      },
    ]);
  });


  it('returns user for correct password', async () => {
    const user = await authenticateCredentials(
      'Active@Example.com',
      FIXTURE_LOGIN,
      { db: db as never },
    );
    expect(user).not.toBeNull();
    expect(user?.email).toBe('active@example.com');
    expect(user?.name).toBe('Active');
    expect(user?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects wrong password', async () => {
    const user = await authenticateCredentials(
      'active@example.com',
      'wrong-password',
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects inactive user even with correct password', async () => {
    const user = await authenticateCredentials(
      'inactive@example.com',
      FIXTURE_LOGIN,
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects suspended user even with correct password', async () => {
    const user = await authenticateCredentials(
      'suspended@example.com',
      FIXTURE_LOGIN,
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects active user without password hash', async () => {
    const user = await authenticateCredentials(
      'nohash@example.com',
      'anything',
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects unknown email', async () => {
    const user = await authenticateCredentials(
      'missing@example.com',
      FIXTURE_LOGIN,
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects empty credentials', async () => {
    expect(await authenticateCredentials('', 'x', { db: db as never })).toBeNull();
    expect(
      await authenticateCredentials('active@example.com', '', { db: db as never }),
    ).toBeNull();
  });
});
