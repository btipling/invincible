/**
 * Phase 4 — light sole-membership lookup (nav chrome / role gates).
 * Does not load sandboxes or decrypt tokens.
 */
import { eq } from 'drizzle-orm';
import {
  createDbConnection,
  tenantMembers,
  type Db,
} from '../../db';
import type { TenantRole } from './roles';

export type SoleMembership =
  | { ok: true; tenantId: string; role: TenantRole }
  | { ok: false; reason: 'no_membership' | 'ambiguous' | 'db' };

export type SoleMembershipDeps = {
  db?: Db;
};

/**
 * v1: exactly one tenant membership for the user.
 */
export async function loadSoleMembership(
  userId: string,
  deps: SoleMembershipDeps = {},
): Promise<SoleMembership> {
  const id = userId?.trim();
  if (!id) {
    return { ok: false, reason: 'no_membership' };
  }

  if (deps.db) {
    return loadWithDb(deps.db, id);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, reason: 'db' };
  }

  const { db, client } = createDbConnection();
  try {
    return await loadWithDb(db, id);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function loadWithDb(db: Db, userId: string): Promise<SoleMembership> {
  try {
    const rows = await db
      .select({
        tenantId: tenantMembers.tenantId,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));

    if (rows.length === 0) {
      return { ok: false, reason: 'no_membership' };
    }
    if (rows.length !== 1) {
      return { ok: false, reason: 'ambiguous' };
    }

    return {
      ok: true,
      tenantId: rows[0].tenantId,
      role: rows[0].role as TenantRole,
    };
  } catch {
    return { ok: false, reason: 'db' };
  }
}
