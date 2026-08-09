import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  listUserSandboxChoices,
  setUserPreferredSandbox,
} from './userPreferredSandbox';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
    '0003_provider_secrets.sql',
    '0004_user_mcp_servers.sql',
    '0005_sandbox_backend.sql',
    '0006_user_github_tokens.sql',
    '0007_user_preferred_sandbox.sql',
  ]) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
}

describe('userPreferredSandbox', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  let tenantId: string;
  let sbA: string;
  let sbB: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.userPreferredSandbox);
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 't1', name: 'T1' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'u@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.insert(schema.tenantMembers).values({
      tenantId,
      userId,
      role: 'owner',
    });

    const [a] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Alpha',
        slug: 'alpha',
        backend: 'vercel',
        image: 'bjorns-projects/invincible/invincible-dev:latest',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sbA = a.id;

    const [b] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Bravo',
        slug: 'bravo',
        backend: 'byo',
        baseUrl: 'http://127.0.0.1:8787',
        tokenCiphertext: 'ct',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sbB = b.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId: sbA,
      userId,
      canRead: true,
      canWrite: true,
    });
  });

  it('lists grants and admin-visible ungranted sandboxes', async () => {
    const listed = await listUserSandboxChoices(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.options).toHaveLength(2);
    const alpha = listed.value.options.find((o) => o.slug === 'alpha');
    const bravo = listed.value.options.find((o) => o.slug === 'bravo');
    expect(alpha?.usable).toBe(true);
    expect(alpha?.granted).toBe(true);
    expect(bravo?.granted).toBe(false);
    expect(bravo?.usable).toBe(false);
  });

  it('set preferred grants admin and saves preference', async () => {
    const set = await setUserPreferredSandbox(userId, sbB, { db: db as never });
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error('expected ok');
    expect(set.value.preferredSandboxId).toBe(sbB);

    const grants = await db
      .select()
      .from(schema.sandboxGrants)
      .where(eq(schema.sandboxGrants.sandboxId, sbB));
    expect(grants).toHaveLength(1);
    expect(grants[0].canWrite).toBe(true);

    const listed = await listUserSandboxChoices(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.preferredSandboxId).toBe(sbB);
  });
});
