import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import { loadAdminContext } from './adminContext';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of ['0000_tenancy_phase1.sql', '0001_sso_scim_identity.sql', '0002_tenant_deks.sql']) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
}

const KEY = Buffer.alloc(32, 7);

describe('loadAdminContext', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let ownerId: string;
  let memberId: string;
  let adminId: string;
  let sandboxId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'acme', name: 'Acme' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', name: 'Owner', status: 'active' })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'member@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    const [admin] = await db
      .insert(schema.users)
      .values({ email: 'admin@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    adminId = admin.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: memberId, role: 'member' },
      { tenantId, userId: adminId, role: 'admin' },
    ]);

    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Default',
        slug: 'default',
        baseUrl: 'https://sandbox.example',
        tokenCiphertext: encryptSecret('super-secret-token-xyz', KEY),
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxId = sb.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId,
      userId: ownerId,
      canRead: true,
      canWrite: true,
    });
  });

  it('loads tenant and masked sandbox for owner', async () => {
    const res = await loadAdminContext(ownerId, {
      db: db as never,
      decrypt: (ct) => decryptSecret(ct, KEY),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.tenant.slug).toBe('acme');
    expect(res.value.canRotate).toBe(true);
    expect(res.value.sandboxes).toHaveLength(1);
    expect(res.value.sandboxes[0].baseUrl).toBe('https://sandbox.example');
    expect(res.value.sandboxes[0].tokenMasked).toMatch(/••••••••/);
    expect(res.value.sandboxes[0].tokenMasked).not.toContain('super-secret');
  });

  it('forbids member role', async () => {
    const res = await loadAdminContext(memberId, { db: db as never });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('allows admin role with canRotate false', async () => {
    const res = await loadAdminContext(adminId, {
      db: db as never,
      decrypt: (ct) => decryptSecret(ct, KEY),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.role).toBe('admin');
    expect(res.value.canAdmin).toBe(true);
    expect(res.value.canRotate).toBe(false);
    expect(res.value.sandboxes).toHaveLength(1);
  });

  it('no_membership when user has none', async () => {
    const [orphan] = await db
      .insert(schema.users)
      .values({ email: 'orphan@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    const res = await loadAdminContext(orphan.id, { db: db as never });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  it('ambiguous when two memberships', async () => {
    const [t2] = await db
      .insert(schema.tenants)
      .values({ slug: 'other', name: 'Other' })
      .returning({ id: schema.tenants.id });
    await db.insert(schema.tenantMembers).values({
      tenantId: t2.id,
      userId: ownerId,
      role: 'owner',
    });
    const res = await loadAdminContext(ownerId, { db: db as never });
    expect(res).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
