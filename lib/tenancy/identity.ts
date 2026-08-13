/**
 * SSO/SCIM identity helpers (parent #64 / phase #75).
 * Pure + DB only — no OIDC provider, no SCIM HTTP.
 */
import { and, asc, count, eq, isNotNull, isNull, or } from 'drizzle-orm';
import {
  tenantMembers,
  tenants,
  users,
  type Db,
  type User,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';

export type UserStatus = 'active' | 'suspended';
export type ProvisionSource = 'credentials' | 'oidc' | 'scim' | 'manual';

export type IdentityDeps = {
  /** Injected DB (tests). When omitted, opens/closes a short-lived connection. */
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'conflict'
      | 'forbidden'
      | 'suspended'
      | 'db',
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

const PROVISION_SOURCES: ReadonlySet<string> = new Set([
  'credentials',
  'oidc',
  'scim',
  'manual',
]);

const USER_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended']);

/** Sign-in eligible only when status is exactly `active`. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return status === 'active';
}

export function assertUserStatus(status: string): asserts status is UserStatus {
  if (!USER_STATUSES.has(status)) {
    throw new IdentityError(
      `invalid status: expected active|suspended, got ${status}`,
      'invalid_input',
    );
  }
}

export function assertProvisionSource(
  source: string,
): asserts source is ProvisionSource {
  if (!PROVISION_SOURCES.has(source)) {
    throw new IdentityError(
      `invalid provision_source: ${source}`,
      'invalid_input',
    );
  }
}

/**
 * Stable IdP subject key: `${issuer}|${sub}` after trim.
 * Rejects empty issuer or sub.
 */
export function normalizeIdpSubject(issuer: string, sub: string): string {
  const i = issuer?.trim() ?? '';
  const s = sub?.trim() ?? '';
  if (!i || !s) {
    throw new IdentityError('issuer and sub are required', 'invalid_input');
  }
  return `${i}|${s}`;
}

function isScimManaged(row: Pick<User, 'provisionSource' | 'scimExternalId'>): boolean {
  return row.provisionSource === 'scim' || row.scimExternalId != null;
}

async function withDb<T>(
  deps: IdentityDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withConnection(deps, fn);
}

/**
 * Attach a user to the **sole** tenant as member (parent #473 phase 1).
 * The first tenant's slug is derived from the sign-up tenant name (no fixed
 * `default`), so this helper stops hardcoding a tenant slug: it enumerates
 * tenants, requires **exactly one**, and joins that one; zero or >1 tenants
 * is fail-closed `forbidden` (a wrong guess is never better than failing).
 * Refuses owner/admin via this helper — owner is created only by first-run
 * sign-up; seed/admin promote only. Idempotent when membership already exists.
 */
export async function ensureDefaultTenantMembership(
  userId: string,
  role: string = 'member',
  deps: IdentityDeps = {},
): Promise<{ tenantId: string; role: string; created: boolean }> {
  const id = userId?.trim();
  if (!id) {
    throw new IdentityError('userId is required', 'invalid_input');
  }
  const r = role?.trim() || 'member';
  if (r === 'owner' || r === 'admin') {
    throw new IdentityError(
      'ensureDefaultTenantMembership cannot grant owner or admin',
      'forbidden',
    );
  }

  return withDb(deps, async (db) => {
    // Sole-tenant join: enumerate and require exactly one; 0 or >1 is a
    // fail-closed signal that member-join cannot be determined safely.
    const tenantRows = await db
      .select({ id: tenants.id })
      .from(tenants)
      .limit(2);
    if (tenantRows.length !== 1) {
      throw new IdentityError(
        'membership join requires exactly one tenant (tenant not bootstrapped or multi-tenant)',
        'forbidden',
      );
    }
    const tenantId = tenantRows[0].id;

    const existing = await db
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, id),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return { tenantId, role: existing[0].role, created: false };
    }

    try {
      await db.insert(tenantMembers).values({
        tenantId,
        userId: id,
        role: r,
      });
      return { tenantId, role: r, created: true };
    } catch (err) {
      // Concurrent ensureDefaultTenantMembership races on PK.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate|primary key/i.test(msg)) {
        throw err;
      }
      const raced = await db
        .select({ role: tenantMembers.role })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, tenantId),
            eq(tenantMembers.userId, id),
          ),
        )
        .limit(1);
      if (raced[0]) {
        return { tenantId, role: raced[0].role, created: false };
      }
      throw err;
    }
  });
}

/** Break-glass: credentials provision_source + owner on any tenant. */
export async function isBreakGlassUser(
  userId: string,
  deps: IdentityDeps = {},
): Promise<boolean> {
  const id = userId?.trim();
  if (!id) return false;

  return withDb(deps, async (db) => {
    const rows = await db
      .select({
        provisionSource: users.provisionSource,
        role: tenantMembers.role,
      })
      .from(users)
      .innerJoin(tenantMembers, eq(tenantMembers.userId, users.id))
      .where(eq(users.id, id));

    return rows.some(
      (row) => row.provisionSource === 'credentials' && row.role === 'owner',
    );
  });
}

export async function assertNotBreakGlass(
  userId: string,
  deps: IdentityDeps = {},
): Promise<void> {
  if (await isBreakGlassUser(userId, deps)) {
    throw new IdentityError(
      'cannot modify break-glass owner via SCIM/identity suspend path',
      'forbidden',
    );
  }
}

export async function setUserStatus(
  userId: string,
  status: UserStatus,
  deps: IdentityDeps = {},
): Promise<User> {
  assertUserStatus(status);
  const id = userId?.trim();
  if (!id) {
    throw new IdentityError('userId is required', 'invalid_input');
  }

  return withDb(deps, async (db) => {
    const updated = await db
      .update(users)
      .set({ status, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    const row = updated[0];
    if (!row) {
      throw new IdentityError('user not found', 'not_found');
    }
    return row;
  });
}

export type FindOrCreateOidcInput = {
  /** Prefer normalizeIdpSubject(issuer, sub) before call */
  subject: string;
  email: string;
  name?: string | null;
  /**
   * Required for email-link path (phase 2 #76).
   * Auto-link existing user with null idp_subject only when true.
   * JIT create of a new email is allowed when false.
   */
  emailVerified: boolean;
};

/**
 * OIDC find-or-create (Auth.js wiring is separate).
 * 1) Match idp_subject
 * 2) Else if email matches user with null idp_subject → link only if emailVerified
 * 3) Else create provision_source=oidc
 * Never rewrites provision_source (SCIM stays scim). Refuses suspended. Ensures membership.
 */
export async function findOrCreateOidcUser(
  input: FindOrCreateOidcInput,
  deps: IdentityDeps = {},
): Promise<{ user: User; created: boolean }> {
  const subject = input.subject?.trim() ?? '';
  const email = input.email?.trim().toLowerCase() ?? '';
  if (!subject || !email) {
    throw new IdentityError('subject and email are required', 'invalid_input');
  }
  const name = input.name?.trim() || null;
  const emailVerified = input.emailVerified === true;

  return withDb(deps, async (db) => {
    const bySubject = await db
      .select()
      .from(users)
      .where(eq(users.idpSubject, subject))
      .limit(1);

    if (bySubject[0]) {
      if (!isActiveStatus(bySubject[0].status)) {
        throw new IdentityError('user is suspended', 'suspended');
      }
      await ensureDefaultTenantMembership(bySubject[0].id, 'member', { db });
      return { user: bySubject[0], created: false };
    }

    const byEmail = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (byEmail[0]) {
      if (!isActiveStatus(byEmail[0].status)) {
        throw new IdentityError('user is suspended', 'suspended');
      }
      if (byEmail[0].idpSubject && byEmail[0].idpSubject !== subject) {
        throw new IdentityError(
          'email already linked to a different idp_subject',
          'conflict',
        );
      }
      if (!byEmail[0].idpSubject) {
        if (!emailVerified) {
          throw new IdentityError(
            'email link requires verified email claim',
            'forbidden',
          );
        }
        try {
          // Preserve provision_source (e.g. scim) — only set idp_subject + name.
          // Require idp_subject still null so concurrent links fail closed.
          const [linked] = await db
            .update(users)
            .set({
              idpSubject: subject,
              name: name ?? byEmail[0].name,
              updatedAt: new Date(),
            })
            .where(
              and(eq(users.id, byEmail[0].id), isNull(users.idpSubject)),
            )
            .returning();
          if (!linked) {
            throw new IdentityError(
              'email already linked to a different idp_subject',
              'conflict',
            );
          }
          await ensureDefaultTenantMembership(linked.id, 'member', { db });
          return { user: linked, created: false };
        } catch (err) {
          if (err instanceof IdentityError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (/unique|duplicate/i.test(msg)) {
            throw new IdentityError(
              'email already linked to a different idp_subject',
              'conflict',
            );
          }
          throw err;
        }
      }
      await ensureDefaultTenantMembership(byEmail[0].id, 'member', { db });
      return { user: byEmail[0], created: false };
    }

    try {
      const [created] = await db
        .insert(users)
        .values({
          email,
          name,
          status: 'active',
          passwordHash: null,
          idpSubject: subject,
          provisionSource: 'oidc',
        })
        .returning();

      await ensureDefaultTenantMembership(created.id, 'member', { db });
      return { user: created, created: true };
    } catch (err) {
      // Concurrent find-or-create: unique on email or idp_subject.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(msg)) {
        throw err;
      }
      const raced = await db
        .select()
        .from(users)
        .where(eq(users.idpSubject, subject))
        .limit(1);
      if (raced[0]) {
        if (!isActiveStatus(raced[0].status)) {
          throw new IdentityError('user is suspended', 'suspended');
        }
        await ensureDefaultTenantMembership(raced[0].id, 'member', { db });
        return { user: raced[0], created: false };
      }
      throw new IdentityError('user conflict', 'conflict');
    }
  });
}

export type ScimCreateInput = {
  externalId?: string | null;
  email: string;
  displayName?: string | null;
  active?: boolean;
};

export async function scimCreateUser(
  input: ScimCreateInput,
  deps: IdentityDeps = {},
): Promise<User> {
  const email = input.email?.trim().toLowerCase() ?? '';
  if (!email) {
    throw new IdentityError('email is required', 'invalid_input');
  }
  const externalId = input.externalId?.trim() || null;
  const displayName = input.displayName?.trim() || null;
  const status: UserStatus = input.active === false ? 'suspended' : 'active';

  return withDb(deps, async (db) => {
    if (externalId) {
      const clash = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.scimExternalId, externalId))
        .limit(1);
      if (clash[0]) {
        throw new IdentityError('scim_external_id already exists', 'conflict');
      }
    }
    const emailClash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (emailClash[0]) {
      throw new IdentityError('email already exists', 'conflict');
    }

    try {
      const [created] = await db
        .insert(users)
        .values({
          email,
          name: displayName,
          status,
          passwordHash: null,
          provisionSource: 'scim',
          scimExternalId: externalId,
        })
        .returning();
      await ensureDefaultTenantMembership(created.id, 'member', { db });
      return created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) {
        throw new IdentityError('user conflict', 'conflict');
      }
      throw err;
    }
  });
}

export type ScimUpdatePatch = {
  email?: string;
  displayName?: string | null;
  active?: boolean;
  externalId?: string | null;
};

export async function scimUpdateUser(
  userId: string,
  patch: ScimUpdatePatch,
  deps: IdentityDeps = {},
): Promise<User> {
  const id = userId?.trim();
  if (!id) {
    throw new IdentityError('userId is required', 'invalid_input');
  }

  return withDb(deps, async (db) => {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new IdentityError('user not found', 'not_found');
    }
    if (!isScimManaged(row)) {
      throw new IdentityError('user is not SCIM-managed', 'forbidden');
    }
    await assertNotBreakGlass(id, { db });

    const set: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!email) {
        throw new IdentityError('email is required', 'invalid_input');
      }
      set.email = email;
    }
    if (patch.displayName !== undefined) {
      set.name = patch.displayName?.trim() || null;
    }
    if (patch.active !== undefined) {
      set.status = patch.active ? 'active' : 'suspended';
    }
    if (patch.externalId !== undefined) {
      set.scimExternalId = patch.externalId?.trim() || null;
    }

    try {
      const [updated] = await db
        .update(users)
        .set(set)
        .where(eq(users.id, id))
        .returning();
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) {
        throw new IdentityError('user conflict', 'conflict');
      }
      throw err;
    }
  });
}

/** Suspend SCIM-managed user (DELETE semantics). No hard delete. */
export async function scimSuspendUser(
  userId: string,
  deps: IdentityDeps = {},
): Promise<User> {
  const id = userId?.trim();
  if (!id) {
    throw new IdentityError('userId is required', 'invalid_input');
  }

  return withDb(deps, async (db) => {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      throw new IdentityError('user not found', 'not_found');
    }
    if (!isScimManaged(row)) {
      throw new IdentityError('user is not SCIM-managed', 'forbidden');
    }
    await assertNotBreakGlass(id, { db });
    return setUserStatus(id, 'suspended', { db });
  });
}


export type ScimListFilter =
  | { kind: 'userName'; value: string }
  | { kind: 'externalId'; value: string };

export type ListScimUsersInput = {
  filter?: ScimListFilter | null;
  startIndex?: number;
  count?: number;
};

/**
 * List SCIM-managed users only (provision_source=scim OR scim_external_id set).
 * Pagination is 1-based startIndex; count default 50.
 */
export async function listScimUsers(
  input: ListScimUsersInput = {},
  deps: IdentityDeps = {},
): Promise<{ users: User[]; totalResults: number }> {
  const startIndex = Math.max(1, input.startIndex ?? 1);
  const limit = Math.max(0, input.count ?? 50);
  const offset = startIndex - 1;

  return withDb(deps, async (db) => {
    const managed = or(
      eq(users.provisionSource, 'scim'),
      isNotNull(users.scimExternalId),
    );
    const parts = [managed];
    if (input.filter?.kind === 'userName') {
      parts.push(eq(users.email, input.filter.value.trim().toLowerCase()));
    } else if (input.filter?.kind === 'externalId') {
      parts.push(eq(users.scimExternalId, input.filter.value.trim()));
    }
    const where = and(...parts);

    const totalRows = await db
      .select({ n: count() })
      .from(users)
      .where(where);
    const totalResults = Number(totalRows[0]?.n ?? 0);

    if (limit === 0) {
      return { users: [], totalResults };
    }

    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(users.email))
      .limit(limit)
      .offset(offset);

    return { users: rows, totalResults };
  });
}

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  provisionSource: string;
  scimExternalId: string | null;
  createdAt: Date;
};

/** All users for admin roster (hybrid visibility). No secrets. */
export async function listUsersForAdmin(
  deps: IdentityDeps = {},
): Promise<AdminUserRow[]> {
  return withDb(deps, async (db) => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        provisionSource: users.provisionSource,
        scimExternalId: users.scimExternalId,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.email));
    return rows;
  });
}

/** Load user by id (tests / callers). */
export async function getUserById(
  userId: string,
  deps: IdentityDeps = {},
): Promise<User | null> {
  const id = userId?.trim();
  if (!id) return null;
  return withDb(deps, async (db) => {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

/** Get SCIM-managed user by id or null if missing/not managed. */
export async function getScimUserById(
  userId: string,
  deps: IdentityDeps = {},
): Promise<User | null> {
  const row = await getUserById(userId, deps);
  if (!row || !isScimManaged(row)) return null;
  return row;
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createIdentity(deps: IdentityDeps = {}) {
  return {
    ensureDefaultTenantMembership: (userId: string, role?: string, o?: IdentityDeps) =>
      ensureDefaultTenantMembership(userId, role, { ...deps, ...o }),
    isBreakGlassUser: (userId: string, o?: IdentityDeps) =>
      isBreakGlassUser(userId, { ...deps, ...o }),
    assertNotBreakGlass: (userId: string, o?: IdentityDeps) =>
      assertNotBreakGlass(userId, { ...deps, ...o }),
    setUserStatus: (userId: string, status: UserStatus, o?: IdentityDeps) =>
      setUserStatus(userId, status, { ...deps, ...o }),
    findOrCreateOidcUser: (input: FindOrCreateOidcInput, o?: IdentityDeps) =>
      findOrCreateOidcUser(input, { ...deps, ...o }),
    scimCreateUser: (input: ScimCreateInput, o?: IdentityDeps) =>
      scimCreateUser(input, { ...deps, ...o }),
    scimUpdateUser: (userId: string, patch: ScimUpdatePatch, o?: IdentityDeps) =>
      scimUpdateUser(userId, patch, { ...deps, ...o }),
    scimSuspendUser: (userId: string, o?: IdentityDeps) =>
      scimSuspendUser(userId, { ...deps, ...o }),
    listScimUsers: (input: ListScimUsersInput, o?: IdentityDeps) =>
      listScimUsers(input, { ...deps, ...o }),
    listUsersForAdmin: (o?: IdentityDeps) =>
      listUsersForAdmin({ ...deps, ...o }),
    getUserById: (userId: string, o?: IdentityDeps) =>
      getUserById(userId, { ...deps, ...o }),
    getScimUserById: (userId: string, o?: IdentityDeps) =>
      getScimUserById(userId, { ...deps, ...o }),
  };
}
