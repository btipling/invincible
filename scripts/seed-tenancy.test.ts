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
  loadTenantDek,
  unwrapTenantDek,
} from '../lib/tenancy/tenantKeys';
import {
  countSeedRows,
  resolveSandboxEnv,
  SANDBOX_SLUG,
  seedTenancy,
  TENANT_SLUG,
} from './seed-tenancy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../db/migrations');

/** Apply all SQL migrations through sandbox backend (#281). */
async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
    '0003_provider_secrets.sql',
    '0004_user_mcp_servers.sql',
    '0005_sandbox_backend.sql',
  ]) {
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

describe('resolveSandboxEnv', () => {
  it('default byo requires url+token', () => {
    expect(() =>
      resolveSandboxEnv({
        SEED_SANDBOX_URL: 'http://x',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/URL\/token/);
    expect(
      resolveSandboxEnv({
        SEED_SANDBOX_URL: 'http://x/',
        SEED_SANDBOX_TOKEN: 't',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      backend: 'byo',
      baseUrl: 'http://x',
      token: 't',
      image: null,
    });
  });

  it('vercel does not require url/token; optional image', () => {
    expect(
      resolveSandboxEnv({
        SEED_SANDBOX_BACKEND: 'vercel',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      backend: 'vercel',
      baseUrl: null,
      token: null,
      image: null,
    });
    expect(
      resolveSandboxEnv({
        SEED_SANDBOX_BACKEND: 'vercel',
        SEED_SANDBOX_IMAGE: 'vercel/sandbox/node:24',
        SEED_SANDBOX_URL: 'http://ignored',
        SEED_SANDBOX_TOKEN: 'ignored',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      backend: 'vercel',
      baseUrl: null,
      token: null,
      image: 'vercel/sandbox/node:24',
    });
  });

  it('vercel rejects invalid image', () => {
    expect(() =>
      resolveSandboxEnv({
        SEED_SANDBOX_BACKEND: 'vercel',
        SEED_SANDBOX_IMAGE: 'not a valid image',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/SEED_SANDBOX_IMAGE/);
  });
});

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
    expect(sb.backend).toBe('byo');
    expect(sb.image).toBeNull();
    expect(sb.baseUrl).toBe('http://127.0.0.1:9999');
    const amk = resolveCredentialsKey({
      CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
    });
    // token under DEK, not AMK
    expect(() => decryptSecret(sb.tokenCiphertext!, amk)).toThrow();
    const { dek, version } = await loadTenantDek(first.tenantId, {
      db: db as never,
      amk,
    });
    expect(decryptSecret(sb.tokenCiphertext!, dek)).toBe('rotated-token');
    expect(sb.tokenKekVersion).toBe(version);

    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, first.tenantId))
      .limit(1);
    expect(tenant.slug).toBe(TENANT_SLUG);
    expect(tenant.dekCiphertext).toBeTruthy();

    // re-seed keeps same DEK
    const dekAgain = unwrapTenantDek(tenant.dekCiphertext!, amk);
    expect(dekAgain.equals(dek)).toBe(true);
  });

  it('seed vercel + optional image; no URL/token required', async () => {
    const env = seedEnv({
      SEED_SANDBOX_BACKEND: 'vercel',
      SEED_SANDBOX_IMAGE: 'team/project/invincible-dev:latest',
      SEED_SANDBOX_URL: '',
      SEED_SANDBOX_TOKEN: '',
    });
    // clear byo defaults from seedEnv by deleting after spread... seedEnv always sets URL/token;
    // resolveSandboxEnv vercel path ignores them after normalize.
    delete (env as Record<string, string | undefined>).SEED_SANDBOX_URL;
    delete (env as Record<string, string | undefined>).SEED_SANDBOX_TOKEN;

    const result = await seedTenancy(env, { db: db as never });
    const [sb] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, result.sandboxId))
      .limit(1);
    expect(sb.backend).toBe('vercel');
    expect(sb.baseUrl).toBeNull();
    expect(sb.tokenCiphertext).toBeNull();
    expect(sb.image).toBe('team/project/invincible-dev:latest');
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
