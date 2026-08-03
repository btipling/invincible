/**
 * Idempotent tenancy seed (phase 1 / #55).
 *
 * Requires:
 *   DATABASE_URL
 *   CREDENTIALS_ENCRYPTION_KEY  (base64 32-byte AES key)
 *   SEED_ADMIN_EMAIL
 *   SEED_ADMIN_PASSWORD
 *   SEED_SANDBOX_URL + SEED_SANDBOX_TOKEN  (or SANDBOX_URL + SANDBOX_TOKEN)
 *
 * Never prints password, token, or encryption key.
 *
 * Usage: npm run db:seed
 */

import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
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

const TENANT_SLUG = 'default';
const SANDBOX_SLUG = 'default';

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

export async function seedTenancy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  requireEnv('DATABASE_URL', env);
  const key = resolveCredentialsKey(env as Record<string, string | undefined>);
  const email = requireEnv('SEED_ADMIN_EMAIL', env).toLowerCase();
  const password = requireEnv('SEED_ADMIN_PASSWORD', env);
  const { baseUrl, token } = resolveSandboxEnv(env);

  const { db, client } = createDbConnection(env.DATABASE_URL);

  try {
    const passwordHash = await hashPassword(password);
    const tokenCiphertext = encryptSecret(token, key);

    // 1) tenant
    const existingTenant = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, TENANT_SLUG))
      .limit(1);
    let tenantId: string;
    if (existingTenant[0]) {
      tenantId = existingTenant[0].id;
    } else {
      const [row] = await db
        .insert(tenants)
        .values({ slug: TENANT_SLUG, name: 'Default', settings: {} })
        .returning({ id: tenants.id });
      tenantId = row.id;
    }

    // 2) user
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    let userId: string;
    if (existingUser[0]) {
      userId = existingUser[0].id;
      await db
        .update(users)
        .set({
          passwordHash,
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    } else {
      const [row] = await db
        .insert(users)
        .values({
          email,
          name: 'Admin',
          status: 'active',
          passwordHash,
        })
        .returning({ id: users.id });
      userId = row.id;
    }

    // 3) member owner
    const existingMember = await db
      .select()
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!existingMember[0]) {
      await db.insert(tenantMembers).values({
        tenantId,
        userId,
        role: 'owner',
      });
    } else if (existingMember[0].role !== 'owner') {
      await db
        .update(tenantMembers)
        .set({ role: 'owner' })
        .where(
          and(
            eq(tenantMembers.tenantId, tenantId),
            eq(tenantMembers.userId, userId),
          ),
        );
    }

    // 4) sandbox
    const existingSandbox = await db
      .select()
      .from(sandboxes)
      .where(
        and(eq(sandboxes.tenantId, tenantId), eq(sandboxes.slug, SANDBOX_SLUG)),
      )
      .limit(1);
    let sandboxId: string;
    if (existingSandbox[0]) {
      sandboxId = existingSandbox[0].id;
      await db
        .update(sandboxes)
        .set({
          baseUrl,
          tokenCiphertext,
          tokenKekVersion: CURRENT_KEK_VERSION,
          status: 'active',
        })
        .where(eq(sandboxes.id, sandboxId));
    } else {
      const [row] = await db
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
        .returning({ id: sandboxes.id });
      sandboxId = row.id;
    }

    // 5) full grant
    const existingGrant = await db
      .select()
      .from(sandboxGrants)
      .where(
        and(
          eq(sandboxGrants.sandboxId, sandboxId),
          eq(sandboxGrants.userId, userId),
        ),
      )
      .limit(1);
    if (!existingGrant[0]) {
      await db.insert(sandboxGrants).values({
        sandboxId,
        userId,
        canRead: true,
        canWrite: true,
      });
    } else {
      await db
        .update(sandboxGrants)
        .set({ canRead: true, canWrite: true })
        .where(
          and(
            eq(sandboxGrants.sandboxId, sandboxId),
            eq(sandboxGrants.userId, userId),
          ),
        );
    }

    return {
      tenantId,
      userId,
      sandboxId,
      grant: { canRead: true, canWrite: true },
    };
  } finally {
    await client.end({ timeout: 5 });
  }
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
