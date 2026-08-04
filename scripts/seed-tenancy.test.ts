import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { decryptSecret, resolveCredentialsKey } from '../lib/tenancy/credentials';
import { verifyPassword } from '../lib/tenancy/password';
import {
  countSeedRows,
  SANDBOX_SLUG,
  seedTenancy,
  TENANT_SLUG,
} from './seed-tenancy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of ['0000_tenancy_phase1.sql', '0001_sso_scim_identity.sql']) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.exec(stmt);
    }
  }
}

function seedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const key = Buffer.alloc(32, 5).toString('base64');
  return {
    NODE_ENV: 'test',
    CREDENTIALS_ENCRYPTION_KEY: key,
    SEED_ADMIN_EMAIL: 'Admin@Example.com',
    SEED_ADMIN_PASSWORD: 'seed-pass-phase1!',
    SEED_SANDBOX_URL: 'http://127.0.0.1:8787/',
    SEED_SANDBOX_TOKEN: 'sandbox-token-secret',
    ...overrides,
  };
}

describe('seedTenancy (pglite)', () => {
  let client: PGlite;
  // drizzle pglite db is structurally compatible with our Db for seed ops
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  it('fails closed without seed credentials', async () => {
    await expect(
      seedTenancy(
        {
          NODE_ENV: 'test',
          CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        },
        { db: db as never },
      ),
    ).rejects.toThrow(/SEED_ADMIN_EMAIL/);
  });

  it('creates 1 tenant / 1 user / 1 sandbox / full grant; second run is idempotent', async () => {
    const env = seedEnv();
    const first = await seedTenancy(env, { db: db as never });
    expect(first.grant).toEqual({ canRead: true, canWrite: true });

    const mid = await countSeedRows(db as never);
    expect(mid).toEqual({
      tenants: 1,
      users: 1,
      members: 1,
      sandboxes: 1,
      grants: 1,
    });

    const second = await seedTenancy(
      seedEnv({
        SEED_ADMIN_PASSWORD: 'rotated-pass!',
        SEED_SANDBOX_TOKEN: 'rotated-token',
        SEED_SANDBOX_URL: 'http://127.0.0.1:9999',
      }),
      { db: db as never },
    );

    // same row ids
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.userId).toBe(first.userId);
    expect(second.sandboxId).toBe(first.sandboxId);

    const end = await countSeedRows(db as never);
    expect(end).toEqual(mid);

    // email lowercased; provision_source credentials on seed insert
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'admin@example.com'))
      .limit(1);
    expect(user).toBeTruthy();
    expect(user.provisionSource).toBe('credentials');
    expect(await verifyPassword('rotated-pass!', user.passwordHash!)).toBe(true);

    const [sb] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, first.sandboxId))
      .limit(1);
    expect(sb.slug).toBe(SANDBOX_SLUG);
    expect(sb.baseUrl).toBe('http://127.0.0.1:9999');
    const key = resolveCredentialsKey({
      CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
    });
    expect(decryptSecret(sb.tokenCiphertext, key)).toBe('rotated-token');

    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, first.tenantId))
      .limit(1);
    expect(tenant.slug).toBe(TENANT_SLUG);
  });

  it('re-seed does not overwrite provision_source on conflict', async () => {
    // Simulate hybrid: change seed user to scim, re-seed same email
    await db
      .update(schema.users)
      .set({ provisionSource: 'scim', scimExternalId: 'seed-collide' })
      .where(eq(schema.users.email, 'admin@example.com'));

    await seedTenancy(
      seedEnv({ SEED_ADMIN_PASSWORD: 'again-pass!' }),
      { db: db as never },
    );

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'admin@example.com'))
      .limit(1);
    expect(user.provisionSource).toBe('scim');
    expect(user.scimExternalId).toBe('seed-collide');
    expect(await verifyPassword('again-pass!', user.passwordHash!)).toBe(true);
  });
});
