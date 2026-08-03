import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { hashPassword } from './password';
import { authenticateCredentials } from './authenticate';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(__dirname, '../../db/migrations/0000_tenancy_phase1.sql'),
  'utf8',
);

describe('authenticateCredentials', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.exec(stmt);
    }
    db = drizzle(client, { schema });

    const activeHash = await hashPassword('correct-horse-battery');
    const inactiveHash = await hashPassword('inactive-pass');
    await db.insert(schema.users).values([
      {
        email: 'active@example.com',
        name: 'Active',
        status: 'active',
        passwordHash: activeHash,
      },
      {
        email: 'inactive@example.com',
        name: 'Inactive',
        status: 'inactive',
        passwordHash: inactiveHash,
      },
      {
        email: 'nohash@example.com',
        name: 'NoHash',
        status: 'active',
        passwordHash: null,
      },
    ]);
  });

  afterAll(async () => {
    await client.close();
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
});
