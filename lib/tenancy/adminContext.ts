/**
 * Phase 4 — load admin context for the signed-in user (v1 sole membership).
 * Phase 2 (#94): mask sandbox tokens via tenant DEK (dual-read / dek-only).
 * Phase 1 sandbox backend (#281): null token → mask without decrypt; null baseUrl → ''.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxGrants,
  sandboxes,
  tenantMembers,
  tenants,
  users,
  type Db,
} from '../../db';
import { maskSecret } from './maskSecret';
import { canAccessAdmin, canRotateSandboxToken, type TenantRole } from './roles';
import { decryptSandboxToken } from './tenantKeys';

export type AdminSandboxRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  baseUrl: string;
  tokenMasked: string;
  canRead: boolean;
  canWrite: boolean;
};

export type AdminContext = {
  user: { id: string; email: string | null; name: string | null };
  tenant: { id: string; slug: string; name: string };
  role: TenantRole;
  canAdmin: boolean;
  canRotate: boolean;
  sandboxes: AdminSandboxRow[];
};

export type LoadAdminContextResult =
  | { ok: true; value: AdminContext }
  | { ok: false; reason: 'no_membership' | 'ambiguous' | 'forbidden' | 'db' };

export type LoadAdminContextDeps = {
  db?: Db;
  /**
   * Override sandbox-token decrypt for tests.
   * Product default: mode-aware tenant DEK (dual / dek-only).
   */
  decryptSandboxToken?: (
    tenantId: string,
    ciphertext: string,
  ) => string | Promise<string>;
};

/**
 * v1: exactly one tenant membership. Admin UI requires owner|admin.
 */
export async function loadAdminContext(
  userId: string,
  deps: LoadAdminContextDeps = {},
): Promise<LoadAdminContextResult> {
  const id = userId?.trim();
  if (!id) {
    return { ok: false, reason: 'forbidden' };
  }

  if (deps.db) {
    return loadWithDb(deps.db, id, deps);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, reason: 'db' };
  }

  const { db, client } = createDbConnection();
  try {
    return await loadWithDb(db, id, deps);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function loadWithDb(
  db: Db,
  userId: string,
  deps: LoadAdminContextDeps,
): Promise<LoadAdminContextResult> {
  try {
    const memberships = await db
      .select({
        tenantId: tenantMembers.tenantId,
        role: tenantMembers.role,
        tenantSlug: tenants.slug,
        tenantName: tenants.name,
        userEmail: users.email,
        userName: users.name,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(eq(tenantMembers.userId, userId));

    if (memberships.length === 0) {
      return { ok: false, reason: 'no_membership' };
    }
    if (memberships.length !== 1) {
      return { ok: false, reason: 'ambiguous' };
    }

    const m = memberships[0];
    const role = m.role as TenantRole;
    if (!canAccessAdmin(role)) {
      return { ok: false, reason: 'forbidden' };
    }

    const decrypt =
      deps.decryptSandboxToken ??
      ((tid: string, ct: string) => decryptSandboxToken(tid, ct, { db }));

    const rows = await db
      .select({
        id: sandboxes.id,
        name: sandboxes.name,
        slug: sandboxes.slug,
        status: sandboxes.status,
        baseUrl: sandboxes.baseUrl,
        tokenCiphertext: sandboxes.tokenCiphertext,
        canRead: sandboxGrants.canRead,
        canWrite: sandboxGrants.canWrite,
      })
      .from(sandboxes)
      .leftJoin(
        sandboxGrants,
        and(
          eq(sandboxGrants.sandboxId, sandboxes.id),
          eq(sandboxGrants.userId, userId),
        ),
      )
      .where(eq(sandboxes.tenantId, m.tenantId));

    const sandboxRows: AdminSandboxRow[] = [];
    for (const r of rows) {
      let tokenMasked = '********';
      const ct = r.tokenCiphertext?.trim() ?? '';
      if (ct) {
        try {
          const plain = await decrypt(m.tenantId, ct);
          tokenMasked = maskSecret(plain);
        } catch {
          tokenMasked = '********';
        }
      }
      sandboxRows.push({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        baseUrl: r.baseUrl ?? '',
        tokenMasked,
        canRead: Boolean(r.canRead),
        canWrite: Boolean(r.canWrite),
      });
    }

    return {
      ok: true,
      value: {
        user: {
          id: userId,
          email: m.userEmail ?? null,
          name: m.userName ?? null,
        },
        tenant: {
          id: m.tenantId,
          slug: m.tenantSlug,
          name: m.tenantName,
        },
        role,
        canAdmin: true,
        canRotate: canRotateSandboxToken(role),
        sandboxes: sandboxRows,
      },
    };
  } catch {
    return { ok: false, reason: 'db' };
  }
}
