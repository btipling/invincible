/**
 * Per-user agent personas CRUD + default resolution (parent #485 / phase 1 #486).
 * Server-only. Bodies are plaintext **non-secret** user content (AGENTS.md-style
 * instruction docs) — no DEK, per product constraint #329. Never ship a body in
 * a client summary.
 *
 * tenantId is always derived from loadSoleMembership — never client input.
 * Every query filters tenantId + userId so a persona can never leak to another
 * user/tenant, and getById returns null for another-user rows (no existence leak).
 */
import { and, eq } from 'drizzle-orm';
import {
  userPersonas,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { loadSoleMembership } from './soleMembership';

/** Display name limits. */
export const PERSONA_NAME_MIN = 1;
export const PERSONA_NAME_MAX = 80;
/** Pretty slug for picker/keys — lowercase start, stable-key friendly. */
export const PERSONA_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Persona body cap (plaintext text; bounded so a single row can't balloon). */
export const PERSONA_BODY_MAX_BYTES = 64 * 1024;

export type UserPersonasDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type UserPersonasErrorCode =
  | 'invalid_name'
  | 'invalid_slug'
  | 'invalid_body'
  | 'duplicate_slug'
  | 'not_found'
  | 'no_membership'
  | 'unavailable';

export type UserPersonasResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserPersonasErrorCode; error: string };

/** Client-safe summary projection (no body). */
export type UserPersonaSummary = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  updatedAt: Date;
};

async function withDb<T>(
  deps: UserPersonasDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withConnection(deps, fn);
}

function isUniqueViolation(err: unknown): boolean {
  const walk = (e: unknown, depth = 0): boolean => {
    if (!e || depth > 4) return false;
    const x = e as {
      code?: string;
      message?: string;
      cause?: unknown;
      constraint?: string;
    };
    if (x.code === '23505') return true;
    if (/unique|duplicate key/i.test(x.message ?? '')) return true;
    return walk(x.cause, depth + 1);
  };
  return walk(err);
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

async function resolveTenantId(
  userId: string,
  deps: UserPersonasDeps,
): Promise<UserPersonasResult<string>> {
  const membership = await loadSoleMembership(userId, deps);
  if (!membership.ok) {
    if (membership.reason === 'db') {
      return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
    }
    return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
  }
  return { ok: true, value: membership.tenantId };
}

function trimName(name: string): string | null {
  const n = name?.trim() ?? '';
  if (n.length < PERSONA_NAME_MIN || n.length > PERSONA_NAME_MAX) return null;
  return n;
}

function trimSlug(slug: string): string | null {
  const s = slug?.trim() ?? '';
  if (!PERSONA_SLUG_RE.test(s)) return null;
  return s;
}

function validateBody(body: string): string | null {
  if (typeof body !== 'string') return null;
  const b = body.trim();
  if (!b) return null;
  if (Buffer.byteLength(b, 'utf8') > PERSONA_BODY_MAX_BYTES) return null;
  return b;
}

function toSummary(
  row: {
    id: string;
    name: string;
    slug: string;
    isDefault: boolean;
    updatedAt: Date;
  },
): UserPersonaSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    updatedAt: row.updatedAt,
  };
}

export type CreateUserPersonaInput = {
  userId: string;
  name: string;
  slug: string;
  body: string;
  /** Optional: mark as the single default. When omitted, existing default kept. */
  isDefault?: boolean;
};

export async function createUserPersona(
  input: CreateUserPersonaInput,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const userId = input.userId?.trim();
  if (!userId) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }
  const name = trimName(input.name);
  if (!name) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${PERSONA_NAME_MIN}–${PERSONA_NAME_MAX} chars`,
    };
  }
  const slug = trimSlug(input.slug);
  if (!slug) {
    return {
      ok: false,
      code: 'invalid_slug',
      error: 'slug must match ^[a-z][a-z0-9_]{0,63}$',
    };
  }
  const body = validateBody(input.body);
  if (!body) {
    return {
      ok: false,
      code: 'invalid_body',
      error: `body is required and must be ≤ ${PERSONA_BODY_MAX_BYTES} bytes`,
    };
  }

  try {
    const tid = await resolveTenantId(userId, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      try {
        const [row] = await db
          .insert(userPersonas)
          .values({
            tenantId: tid.value,
            userId,
            name,
            slug,
            body,
            isDefault: input.isDefault === true,
          })
          .returning({ id: userPersonas.id });
        return { ok: true as const, value: { id: row.id } };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return {
            ok: false as const,
            code: 'duplicate_slug' as const,
            error: 'slug already exists for user',
          };
        }
        throw err;
      }
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error: 'user_personas table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'could not create persona' };
  }
}

/** Rename only; keeps body + isDefault. */
export async function renameUserPersona(
  userId: string,
  id: string,
  name: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'persona not found' };
  }
  const clean = trimName(name);
  if (!clean) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${PERSONA_NAME_MIN}–${PERSONA_NAME_MAX} chars`,
    };
  }

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userPersonas)
        .set({ name: clean, updatedAt: new Date() })
        .where(and(eq(userPersonas.id, pid), eq(userPersonas.userId, uid)))
        .returning({ id: userPersonas.id });
      if (!updated[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'persona not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not rename persona' };
  }
}

/** Replace the persona body (keeps name/slug/isDefault). */
export async function updateUserPersonaBody(
  userId: string,
  id: string,
  body: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'persona not found' };
  }
  const clean = validateBody(body);
  if (!clean) {
    return {
      ok: false,
      code: 'invalid_body',
      error: `body is required and must be ≤ ${PERSONA_BODY_MAX_BYTES} bytes`,
    };
  }

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userPersonas)
        .set({ body: clean, updatedAt: new Date() })
        .where(and(eq(userPersonas.id, pid), eq(userPersonas.userId, uid)))
        .returning({ id: userPersonas.id });
      if (!updated[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'persona not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not update persona' };
  }
}

export async function deleteUserPersona(
  userId: string,
  id: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'persona not found' };
  }
  try {
    return await withDb(deps, async (db) => {
      const deleted = await db
        .delete(userPersonas)
        .where(and(eq(userPersonas.id, pid), eq(userPersonas.userId, uid)))
        .returning({ id: userPersonas.id });
      if (!deleted[0]) {
        return { ok: false, code: 'not_found', error: 'persona not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not delete persona' };
  }
}

/**
 * Scoped single row including body (server-side injection resolves body by id).
 * Returns null for another-user/tenant rows (no existence leak).
 */
export async function getPersonaById(
  userId: string,
  id: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  slug: string;
  body: string;
  isDefault: boolean;
} | null>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: true, value: null };
  }
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select()
        .from(userPersonas)
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true as const, value: null };
      return {
        ok: true as const,
        value: {
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          name: row.name,
          slug: row.slug,
          body: row.body,
          isDefault: row.isDefault,
        },
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not load persona' };
  }
}

/** List summaries (no body) for the picker. */
export async function listUserPersonas(
  userId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<UserPersonaSummary[]>> {
  const uid = userId?.trim();
  if (!uid) return { ok: true, value: [] };
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          id: userPersonas.id,
          name: userPersonas.name,
          slug: userPersonas.slug,
          isDefault: userPersonas.isDefault,
          updatedAt: userPersonas.updatedAt,
        })
        .from(userPersonas)
        .where(
          and(eq(userPersonas.userId, uid), eq(userPersonas.tenantId, tid.value)),
        );
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true as const, value: rows.map(toSummary) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list personas' };
  }
}

/** Default persona (scoped) or null when none set. */
export async function resolveDefaultPersona(
  userId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<UserPersonaSummary | null>> {
  const uid = userId?.trim();
  if (!uid) return { ok: true, value: null };
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          id: userPersonas.id,
          name: userPersonas.name,
          slug: userPersonas.slug,
          isDefault: userPersonas.isDefault,
          updatedAt: userPersonas.updatedAt,
        })
        .from(userPersonas)
        .where(
          and(
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
            eq(userPersonas.isDefault, true),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true as const, value: null };
      return { ok: true as const, value: toSummary(row) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not resolve default persona' };
  }
}

/**
 * Promote a persona to the single default (atomic): clears all others, sets the
 * target. No-op safe when not_found (returns not_found for an absent id).
 */
export async function setDefaultPersona(
  userId: string,
  id: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'persona not found' };
  }
  try {
    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        const target = await tx
          .select({ id: userPersonas.id })
          .from(userPersonas)
          .where(and(eq(userPersonas.id, pid), eq(userPersonas.userId, uid)))
          .limit(1);
        if (!target[0]) {
          return {
            ok: false as const,
            code: 'not_found' as const,
            error: 'persona not found',
          };
        }
        await tx
          .update(userPersonas)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(userPersonas.userId, uid));
        await tx
          .update(userPersonas)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(userPersonas.id, pid));
        return { ok: true as const, value: { id: pid } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not set default persona' };
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createUserPersonas(deps: UserPersonasDeps = {}) {
  return {
    createUserPersona: (input: CreateUserPersonaInput, o?: UserPersonasDeps) =>
      createUserPersona(input, { ...deps, ...o }),
    renameUserPersona: (userId: string, id: string, name: string, o?: UserPersonasDeps) =>
      renameUserPersona(userId, id, name, { ...deps, ...o }),
    updateUserPersonaBody: (userId: string, id: string, body: string, o?: UserPersonasDeps) =>
      updateUserPersonaBody(userId, id, body, { ...deps, ...o }),
    deleteUserPersona: (userId: string, id: string, o?: UserPersonasDeps) =>
      deleteUserPersona(userId, id, { ...deps, ...o }),
    getPersonaById: (userId: string, id: string, o?: UserPersonasDeps) =>
      getPersonaById(userId, id, { ...deps, ...o }),
    listUserPersonas: (userId: string, o?: UserPersonasDeps) =>
      listUserPersonas(userId, { ...deps, ...o }),
    resolveDefaultPersona: (userId: string, o?: UserPersonasDeps) =>
      resolveDefaultPersona(userId, { ...deps, ...o }),
    setDefaultPersona: (userId: string, id: string, o?: UserPersonasDeps) =>
      setDefaultPersona(userId, id, { ...deps, ...o }),
  };
}
