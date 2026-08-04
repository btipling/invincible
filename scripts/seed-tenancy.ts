/**
 * Idempotent tenancy seed (phase 1 / #55).
 *
 * Requires (live run):
 *   DATABASE_URL
 *   CREDENTIALS_ENCRYPTION_KEY  (base64 32-byte AES key)
 *   SEED_ADMIN_EMAIL
 *   SEED_ADMIN_PASSWORD
 *   SEED_SANDBOX_URL + SEED_SANDBOX_TOKEN  (or SANDBOX_URL + SANDBOX_TOKEN)
 *
 * Never prints password, token, or encryption key.
 * Re-running resets bootstrap password_hash + sandbox token ciphertext (by design).
 *
 * Usage: npm run db:seed
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  createDbConnection,
  type Db,
  sandboxes,
  sandboxGrants,
  tenantMembers,
  tenants,
  users,
} from '../db';
import {
  CURRENT_KEK_VERSION,
  encryptSecret,
  resolveCredentialsKey,
} from '../lib/tenancy/credentials';
import { hashPassword } from '../lib/tenancy/password';

export const TENANT_SLUG = 'default';
export const SANDBOX_SLUG = 'default';

function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is required for seed`);
  }
  return v;
}

function resolveSandboxEnv(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  token: string;
} {
  const baseUrl =
    env.SEED_SANDBOX_URL?.trim() || env.SANDBOX_URL?.trim() || '';
  const token =
    env.SEED_SANDBOX_TOKEN?.trim() || env.SANDBOX_TOKEN?.trim() || '';
  if (!baseUrl || !token) {
    throw new Error(
      'Sandbox URL/token required: set SEED_SANDBOX_URL+SEED_SANDBOX_TOKEN or SANDBOX_URL+SANDBOX_TOKEN',
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

export type SeedResult = {
  tenantId: string;
  userId: string;
  sandboxId: string;
  grant: { canRead: boolean; canWrite: boolean };
};

export type SeedOptions = {
  /** Injected DB (tests). When set, caller owns lifecycle — no connect/end. */
  db?: Db;
};

/**
 * Upsert tenant/user/member/sandbox/grant inside a single transaction.
 * Uses ON CONFLICT so concurrent seeds do not TOCTOU-duplicate.
 */
export async function seedTenancy(
  env: NodeJS.ProcessEnv = process.env,
  options: SeedOptions = {},
): Promise<SeedResult> {
  if (!options.db) {
    requireEnv('DATABASE_URL', env);
  }
  const key = resolveCredentialsKey(env as Record<string, string | undefined>);
  const email = requireEnv('SEED_ADMIN_EMAIL', env).toLowerCase();
  const password = requireEnv('SEED_ADMIN_PASSWORD', env);
  const { baseUrl, token } = resolveSandboxEnv(env);

  const passwordHash = await hashPassword(password);
  const tokenCiphertext = encryptSecret(token, key);

  const owned = !options.db;
  const conn = options.db ? null : createDbConnection(env.DATABASE_URL);
  const db = options.db ?? conn!.db;

  try {
    return await db.transaction(async (tx) => {
      // 1) tenant slug `default`
      await tx
        .insert(tenants)
        .values({ slug: TENANT_SLUG, name: 'Default', settings: {} })
        .onConflictDoNothing({ target: tenants.slug });

      const tenantRow = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, TENANT_SLUG))
        .limit(1);
      const tenantId = tenantRow[0]?.id;
      if (!tenantId) {
        throw new Error('seed failed: tenant missing after upsert');
      }

      // 2) user by email — re-seed refreshes password_hash (bootstrap contract).
      // Insert sets provision_source=credentials; conflict does NOT overwrite
      // provision_source (hybrid: preserve scim/oidc if email collides).
      await tx
        .insert(users)
        .values({
          email,
          name: 'Admin',
          status: 'active',
          passwordHash,
          provisionSource: 'credentials',
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            passwordHash,
            status: 'active',
            updatedAt: new Date(),
          },
        });

      const userRow = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const userId = userRow[0]?.id;
      if (!userId) {
        throw new Error('seed failed: user missing after upsert');
      }

      // 3) member owner
      await tx
        .insert(tenantMembers)
        .values({
          tenantId,
          userId,
          role: 'owner',
        })
        .onConflictDoUpdate({
          target: [tenantMembers.tenantId, tenantMembers.userId],
          set: { role: 'owner' },
        });

      // 4) sandbox under tenant
      await tx
        .insert(sandboxes)
        .values({
          tenantId,
          name: 'Default',
          slug: SANDBOX_SLUG,
          baseUrl,
          tokenCiphertext,
          tokenKekVersion: CURRENT_KEK_VERSION,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [sandboxes.tenantId, sandboxes.slug],
          set: {
            baseUrl,
            tokenCiphertext,
            tokenKekVersion: CURRENT_KEK_VERSION,
            status: 'active',
          },
        });

      const sandboxRow = await tx
        .select({ id: sandboxes.id })
        .from(sandboxes)
        .where(
          and(eq(sandboxes.tenantId, tenantId), eq(sandboxes.slug, SANDBOX_SLUG)),
        )
        .limit(1);
      const sandboxId = sandboxRow[0]?.id;
      if (!sandboxId) {
        throw new Error('seed failed: sandbox missing after upsert');
      }

      // 5) full R/W grant
      await tx
        .insert(sandboxGrants)
        .values({
          sandboxId,
          userId,
          canRead: true,
          canWrite: true,
        })
        .onConflictDoUpdate({
          target: [sandboxGrants.sandboxId, sandboxGrants.userId],
          set: { canRead: true, canWrite: true },
        });

      return {
        tenantId,
        userId,
        sandboxId,
        grant: { canRead: true, canWrite: true },
      };
    });
  } finally {
    if (owned && conn) {
      await conn.client.end({ timeout: 5 });
    }
  }
}

/** Count helpers for tests / operators (no secrets). */
export async function countSeedRows(db: Db): Promise<{
  tenants: number;
  users: number;
  members: number;
  sandboxes: number;
  grants: number;
}> {
  const one = async (
    table:
      | typeof tenants
      | typeof users
      | typeof tenantMembers
      | typeof sandboxes
      | typeof sandboxGrants,
  ) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table);
    return Number(row?.n ?? 0);
  };
  return {
    tenants: await one(tenants),
    users: await one(users),
    members: await one(tenantMembers),
    sandboxes: await one(sandboxes),
    grants: await one(sandboxGrants),
  };
}

async function main() {
  const result = await seedTenancy();
  console.log(
    JSON.stringify({
      ok: true,
      tenantId: result.tenantId,
      userId: result.userId,
      sandboxId: result.sandboxId,
      grant: result.grant,
      tenantSlug: TENANT_SLUG,
      sandboxSlug: SANDBOX_SLUG,
    }),
  );
}

// Only auto-run when executed as the seed script entrypoint.
const entry = process.argv[1] ?? '';
const isMain =
  entry.endsWith('seed-tenancy.ts') || entry.endsWith('seed-tenancy.js');

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
