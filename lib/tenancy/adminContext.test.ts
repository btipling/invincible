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
const migrationSql = readFileSync(
  join(__dirname, '../../db/migrations/0000_tenancy_phase1.sql'),
  'utf8',
);

const KEY = Buffer.alloc(32, 7);

describe('loadAdminContext', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let ownerId: string;
  let memberId: string;
  let sandboxId: string;

  beforeAll(async () => {
    client = new PGlite();
    for (const stmt of migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
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

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: memberId, role: 'member' },
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
});
