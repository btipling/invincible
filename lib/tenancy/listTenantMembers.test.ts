import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { listTenantMembersForAdmin } from './listTenantMembers';

describe('listTenantMembersForAdmin', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let otherTenantId: string;
  let memberId: string;
  let outsiderId: string;

  beforeAll(async () => {

    ({ client, db } = await createTenancyTestDb());
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
