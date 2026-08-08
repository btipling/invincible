import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { listTenantMembersForAdmin } from './listTenantMembers';

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

describe('listTenantMembersForAdmin', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let otherTenantId: string;
  let memberId: string;
  let outsiderId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 't', name: 'T' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;
    const [other] = await db
      .insert(schema.tenants)
      .values({ slug: 'o', name: 'O' })
      .returning({ id: schema.tenants.id });
    otherTenantId = other.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'm@t.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;
    const [outsider] = await db
      .insert(schema.users)
      .values({ email: 'x@o.com', status: 'active' })
      .returning({ id: schema.users.id });
    outsiderId = outsider.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: memberId, role: 'member' },
      { tenantId: otherTenantId, userId: outsiderId, role: 'owner' },
    ]);
  });

  it('returns only members of the requested tenant', async () => {
    const rows = await listTenantMembersForAdmin(tenantId, { db: db as never });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(memberId);
    expect(rows[0].email).toBe('m@t.com');
    expect(rows.map((r) => r.userId)).not.toContain(outsiderId);
  });
});
