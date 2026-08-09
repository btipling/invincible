/**
 * Per-user preferred sandbox selection (Settings → Sandbox).
 * When multiple usable grants exist, resolveAgentSandbox uses this preference.
 * Admins may select a tenant sandbox they are not yet granted — selection
 * grants them read+write on that row.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxGrants,
  sandboxes,
  userPreferredSandbox,
  type Db,
} from '../../db';
import { canAccessAdmin } from './roles';
import { isUsableGrant } from './grants';
import { loadSoleMembership } from './soleMembership';

export type UserPreferredSandboxDeps = {
  db?: Db;
};

export type UserPreferredSandboxErrorCode =
  | 'no_membership'
  | 'not_found'
  | 'forbidden'
  | 'unavailable'
  | 'invalid';

export type UserPreferredSandboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserPreferredSandboxErrorCode; error: string };

export type SandboxChoice = {
  sandboxId: string;
  name: string;
  slug: string;
  backend: string;
  status: string;
  image: string | null;
  /** Active + grant read or write. */
  usable: boolean;
  /** User has a grant row. */
  granted: boolean;
  canRead: boolean;
  canWrite: boolean;
};

export type UserSandboxSelection = {
  preferredSandboxId: string | null;
  options: SandboxChoice[];
};

async function withDb<T>(
  deps: UserPreferredSandboxDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) return fn(deps.db);
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

function isUndefinedTable(err: unknown): boolean {
  const walk = (e: unknown, depth = 0): boolean => {
    if (!e || depth > 4) return false;
    const x = e as { code?: string; message?: string; cause?: unknown };
    if (x.code === '42P01') return true;
    if (/relation .* does not exist|undefined_table/i.test(x.message ?? '')) {
      return true;
    }
    return walk(x.cause, depth + 1);
  };
  return walk(err);
}

/**
 * List sandboxes the user can pick: all grants, plus (for admins) other
 * tenant sandboxes they may self-grant by selecting.
 */
export async function listUserSandboxChoices(
  userId: string,
  deps: UserPreferredSandboxDeps = {},
): Promise<UserPreferredSandboxResult<UserSandboxSelection>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const membership = await loadSoleMembership(uid, { db: deps.db });
    if (!membership.ok) {
      if (membership.reason === 'db') {
        return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
      }
      return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
    }
    const tenantId = membership.tenantId;
    const isAdmin = canAccessAdmin(membership.role);

    return await withDb(deps, async (db) => {
      const prefRows = await db
        .select({ sandboxId: userPreferredSandbox.sandboxId })
        .from(userPreferredSandbox)
        .where(eq(userPreferredSandbox.userId, uid))
        .limit(1);
      const preferredSandboxId = prefRows[0]?.sandboxId ?? null;

      const grantRows = await db
        .select({
          sandboxId: sandboxes.id,
          name: sandboxes.name,
          slug: sandboxes.slug,
          backend: sandboxes.backend,
          status: sandboxes.status,
          image: sandboxes.image,
          canRead: sandboxGrants.canRead,
          canWrite: sandboxGrants.canWrite,
        })
        .from(sandboxGrants)
        .innerJoin(sandboxes, eq(sandboxGrants.sandboxId, sandboxes.id))
        .where(
          and(eq(sandboxGrants.userId, uid), eq(sandboxes.tenantId, tenantId)),
        );

      const byId = new Map<string, SandboxChoice>();
      for (const r of grantRows) {
        const usable = isUsableGrant(r.status, {
          canRead: r.canRead,
          canWrite: r.canWrite,
        });
        byId.set(r.sandboxId, {
          sandboxId: r.sandboxId,
          name: r.name,
          slug: r.slug,
          backend: r.backend,
          status: r.status,
          image: r.image,
          usable,
          granted: true,
          canRead: Boolean(r.canRead),
          canWrite: Boolean(r.canWrite),
        });
      }

      if (isAdmin) {
        const all = await db
          .select({
            sandboxId: sandboxes.id,
            name: sandboxes.name,
            slug: sandboxes.slug,
            backend: sandboxes.backend,
            status: sandboxes.status,
            image: sandboxes.image,
          })
          .from(sandboxes)
          .where(eq(sandboxes.tenantId, tenantId));
        for (const r of all) {
          if (byId.has(r.sandboxId)) continue;
          byId.set(r.sandboxId, {
            sandboxId: r.sandboxId,
            name: r.name,
            slug: r.slug,
            backend: r.backend,
            status: r.status,
            image: r.image,
            usable: false,
            granted: false,
            canRead: false,
            canWrite: false,
          });
        }
      }

      const options = [...byId.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
      );

      return {
        ok: true as const,
        value: { preferredSandboxId, options },
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_preferred_sandbox table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to list sandboxes' };
  }
}

/**
 * Set preferred sandbox. Ensures a R/W grant when the actor is an admin of
 * the tenant and currently ungranted (self-service switch).
 */
export async function setUserPreferredSandbox(
  userId: string,
  sandboxId: string,
  deps: UserPreferredSandboxDeps = {},
): Promise<UserPreferredSandboxResult<{ preferredSandboxId: string }>> {
  const uid = userId?.trim();
  const sid = sandboxId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }
  if (!sid) {
    return { ok: false, code: 'invalid', error: 'sandboxId is required' };
  }

  try {
    const membership = await loadSoleMembership(uid, { db: deps.db });
    if (!membership.ok) {
      if (membership.reason === 'db') {
        return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
      }
      return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
    }
    const tenantId = membership.tenantId;
    const isAdmin = canAccessAdmin(membership.role);

    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        const sbRows = await tx
          .select({
            id: sandboxes.id,
            tenantId: sandboxes.tenantId,
            status: sandboxes.status,
          })
          .from(sandboxes)
          .where(eq(sandboxes.id, sid))
          .limit(1);
        const sb = sbRows[0];
        if (!sb || sb.tenantId !== tenantId) {
          return { ok: false as const, code: 'not_found' as const, error: 'sandbox not found' };
        }

        const grantRows = await tx
          .select({
            canRead: sandboxGrants.canRead,
            canWrite: sandboxGrants.canWrite,
          })
          .from(sandboxGrants)
          .where(
            and(eq(sandboxGrants.sandboxId, sid), eq(sandboxGrants.userId, uid)),
          )
          .limit(1);
        let canRead = grantRows[0]?.canRead ?? false;
        let canWrite = grantRows[0]?.canWrite ?? false;

        if (!grantRows[0]) {
          if (!isAdmin) {
            return {
              ok: false as const,
              code: 'forbidden' as const,
              error: 'no grant on this sandbox',
            };
          }
          // Admin self-grant R/W so the preference is usable immediately.
          await tx.insert(sandboxGrants).values({
            sandboxId: sid,
            userId: uid,
            canRead: true,
            canWrite: true,
          });
          canRead = true;
          canWrite = true;
        }

        if (!isUsableGrant(sb.status, { canRead, canWrite })) {
          return {
            ok: false as const,
            code: 'invalid' as const,
            error: 'sandbox is not usable (inactive or no permissions)',
          };
        }

        const now = new Date();
        await tx
          .insert(userPreferredSandbox)
          .values({
            userId: uid,
            tenantId,
            sandboxId: sid,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userPreferredSandbox.userId,
            set: {
              tenantId,
              sandboxId: sid,
              updatedAt: now,
            },
          });

        return {
          ok: true as const,
          value: { preferredSandboxId: sid },
        };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_preferred_sandbox table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to save preference' };
  }
}

/**
 * Load preferred sandbox id for resolve (null if unset / missing table / mismatch).
 * Soft: never throws for missing preference.
 */
export async function getUserPreferredSandboxId(
  userId: string,
  tenantId: string,
  deps: UserPreferredSandboxDeps = {},
): Promise<string | null> {
  const uid = userId?.trim();
  const tid = tenantId?.trim();
  if (!uid || !tid) return null;

  try {
    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          sandboxId: userPreferredSandbox.sandboxId,
          tenantId: userPreferredSandbox.tenantId,
        })
        .from(userPreferredSandbox)
        .where(eq(userPreferredSandbox.userId, uid))
        .limit(1);
      const row = rows[0];
      if (!row || row.tenantId !== tid) return null;
      return row.sandboxId;
    });
  } catch {
    return null;
  }
}
