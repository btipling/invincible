import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { loadSoleMembership } from './soleMembership';

describe('loadSoleMembership', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {

    ({ client, db } = await createTenancyTestDb());
  });


  beforeEach(async () => {
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'acme', name: 'Acme' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'u@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    userId = user.id;
  });

  it('returns role for sole membership', async () => {
    await db.insert(schema.tenantMembers).values({
      tenantId,
      userId,
      role: 'admin',
    });
    const res = await loadSoleMembership(userId, { db: db as never });
    expect(res).toEqual({ ok: true, tenantId, role: 'admin' });
  });

  it('no_membership when empty', async () => {
    const res = await loadSoleMembership(userId, { db: db as never });
    expect(res).toEqual({ ok: false, reason: 'no_membership' });
  });

  it('ambiguous when two memberships', async () => {
    const [t2] = await db
      .insert(schema.tenants)
      .values({ slug: 'other', name: 'Other' })
      .returning({ id: schema.tenants.id });
    await db.insert(schema.tenantMembers).values([
      { tenantId, userId, role: 'owner' },
      { tenantId: t2.id, userId, role: 'member' },
    ]);
    const res = await loadSoleMembership(userId, { db: db as never });
    expect(res).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
