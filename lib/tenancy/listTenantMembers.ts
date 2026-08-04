/**
 * Tenant-scoped member list for admin grant pickers (parent #102 / phase #105).
 * Never use listUsersForAdmin for grants — that list is global.
 */
import { asc, eq } from 'drizzle-orm';
import {
  createDbConnection,
  tenantMembers,
  users,
  type Db,
} from '../../db';
import type { TenantRole } from './roles';

export type TenantMemberRow = {
  userId: string;
  email: string;
  name: string | null;
  role: TenantRole;
  status: string;
};

export type ListTenantMembersDeps = {
  db?: Db;
};

async function withDb<T>(
  deps: ListTenantMembersDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) {
    return fn(deps.db);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required');
  }
  const { db, client } = createDbConnection();
  try {
    return await fn(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Members of a single tenant (for grant multi-select).
 * Sorted by email ASC.
 */
export async function listTenantMembersForAdmin(
  tenantId: string,
  deps: ListTenantMembersDeps = {},
): Promise<TenantMemberRow[]> {
  const tid = tenantId?.trim();
  if (!tid) return [];

  return withDb(deps, async (db) => {
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: tenantMembers.role,
        status: users.status,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(eq(tenantMembers.tenantId, tid))
      .orderBy(asc(users.email));

    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role as TenantRole,
      status: r.status,
    }));
  });
}
