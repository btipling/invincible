import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { hashPassword } from './password';
import { authenticateCredentials } from './authenticate';
import { getSharedDb, resetTenantTables } from './test/shared';

let db!: ReturnType<typeof drizzle<typeof schema>>;

async function seedUsers() {
  const activeHash = await hashPassword('correct-horse-battery');
  const inactiveHash = await hashPassword('inactive-pass');
  const suspendedHash = await hashPassword('suspended-pass');
  await db.insert(schema.users).values([
    {
      email: 'active@example.com',
      name: 'Active',
      status: 'active',
      passwordHash: activeHash,
      provisionSource: 'credentials',
    },
    {
      email: 'inactive@example.com',
      name: 'Inactive',
      status: 'inactive',
      passwordHash: inactiveHash,
      provisionSource: 'credentials',
    },
    {
      email: 'suspended@example.com',
      name: 'Suspended',
      status: 'suspended',
      passwordHash: suspendedHash,
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
}

describe('authenticateCredentials', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
    await seedUsers();
  });

  it('returns user for correct password', async () => {
    const user = await authenticateCredentials(
      'Active@Example.com',
      'correct-horse-battery',
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
      'inactive-pass',
      { db: db as never },
    );
    expect(user).toBeNull();
  });

  it('rejects suspended user even with correct password', async () => {
    const user = await authenticateCredentials(
      'suspended@example.com',
      'suspended-pass',
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
      'correct-horse-battery',
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

  it('fails closed to null when no connection source is configured', async () => {
    // Neither `db` nor `connect` supplied → missing-dependency wiring error.
    // Mirrors pre-DI "no DATABASE_URL" behavior: treated as an auth failure,
    // not a thrown 500.
    await expect(
      authenticateCredentials('active@example.com', 'anything', {}),
    ).resolves.toBeNull();
  });

  it('propagates DB query / lookup errors instead of masking them as bad password', async () => {
    // A live `db` whose query fails (e.g. an outage / missing table) must NOT be
    // swallowed into a `null` "bad password" — it should surface to NextAuth as
    // a real infra error, preserving pre-DI public behavior.
    const brokenDb = {
      select: () => {
        throw new Error('connection reset');
      },
    } as never;

    await expect(
      authenticateCredentials('active@example.com', 'anything', { db: brokenDb }),
    ).rejects.toThrow('connection reset');
  });

  it('propagates lookup errors surfaced through an injected connect provider', async () => {
    const boomDb = {
      select: () => {
        throw new Error('query timeout');
      },
    };
    await expect(
      authenticateCredentials('active@example.com', 'anything', {
        connect: async () => ({ db: boomDb as never, close: async () => {} }),
      }),
    ).rejects.toThrow('query timeout');
  });
});
