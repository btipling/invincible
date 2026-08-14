/**
 * Per-user agent skills CRUD + body lookup (parent #331 / phase 1 #498).
 * Server-only. Bodies are plaintext **non-secret** user content (playbooks /
 * AGENTS-md-style instruction docs) — no DEK, same policy as personas.
 * Never ship a body in a client summary.
 *
 * Skills attach per-turn via slash command (phase 3) and are re-resolved from
 * this store each turn; they are NOT snapshotted into session `meta` (unlike
 * locked personas). `getSkillBySlug` is the server injection seam.
 *
 * tenantId is always derived from loadSoleMembership — never client input.
 * Every query filters tenantId + userId so a skill can never leak to another
 * user/tenant, and getSkillBySlug returns null for another-user rows (no
 * existence leak).
 */
import { and, desc, eq } from 'drizzle-orm';
import {
  userSkills,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { loadSoleMembership } from './soleMembership';

/** Display name limits (mirror personas; generously raised in #514). */
export const SKILL_NAME_MIN = 1;
export const SKILL_NAME_MAX = 200;
/** Short summary shown by /api/skills and find_skill. */
export const SKILL_DESCRIPTION_MAX_CHARS = 2000;
/**
 * Slug charset (parent #495 locked single source of truth, shared with the
 * phase-3 slash parser): lowercase start; digits, underscore AND hyphen allowed;
 * ≤ 128 chars (raised from 64 in #514). Hyphens are permitted so a kebab-case
 * skill like `create-plan` stores here and resolves as `/create-plan`. Do NOT
 * copy personas' underscore-only RE.
 */
export const SKILL_SLUG_RE = /^[a-z][a-z0-9_-]{0,127}$/;
/**
 * Skill body cap (plaintext; bounded so a single row can't balloon). Raised to
 * 4 MiB in #514 (generous, per the #512 caps direction). Skills are
 * store-hosted and re-resolved per turn — never snapshotted into `meta` — so
 * this caps the body field, not a merged meta budget.
 */
export const SKILL_BODY_MAX_BYTES = 4 * 1024 * 1024;

export type UserSkillsDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type UserSkillsErrorCode =
  | 'invalid_name'
  | 'invalid_slug'
  | 'invalid_body'
  | 'invalid_description'
  | 'duplicate_slug'
  | 'not_found'
  | 'no_membership'
  | 'unavailable';

export type UserSkillsResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserSkillsErrorCode; error: string };

/** Client-safe summary projection (no body). */
export type UserSkillSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  updatedAt: Date;
};

async function withDb<T>(
  deps: UserSkillsDeps,
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
  deps: UserSkillsDeps,
): Promise<UserSkillsResult<string>> {
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
  if (n.length < SKILL_NAME_MIN || n.length > SKILL_NAME_MAX) return null;
  return n;
}

function trimDescription(description: string): string | null {
  const d = typeof description === 'string' ? description.trim() : '';
  if (d.length > SKILL_DESCRIPTION_MAX_CHARS) return null;
  return d;
}

function trimSlug(slug: string): string | null {
  const s = slug?.trim() ?? '';
  if (!SKILL_SLUG_RE.test(s)) return null;
  return s;
}

function validateBody(body: string): string | null {
  if (typeof body !== 'string') return null;
  const b = body.trim();
  if (!b) return null;
  if (Buffer.byteLength(b, 'utf8') > SKILL_BODY_MAX_BYTES) return null;
  return b;
}

function toSummary(
  row: {
    id: string;
    name: string;
    slug: string;
    description: string;
    updatedAt: Date;
  },
): UserSkillSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    updatedAt: row.updatedAt,
  };
}

export type CreateUserSkillInput = {
  userId: string;
  name: string;
  slug: string;
  body: string;
  description?: string;
};

export async function createUserSkill(
  input: CreateUserSkillInput,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const userId = input.userId?.trim();
  if (!userId) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }
  const name = trimName(input.name);
  if (!name) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${SKILL_NAME_MIN}–${SKILL_NAME_MAX} chars`,
    };
  }
  const slug = trimSlug(input.slug);
  if (!slug) {
    return {
      ok: false,
      code: 'invalid_slug',
      error: 'slug must match ^[a-z][a-z0-9_-]{0,127}$',
    };
  }
  const body = validateBody(input.body);
  if (!body) {
    return {
      ok: false,
      code: 'invalid_body',
      error: `body is required and must be ≤ ${SKILL_BODY_MAX_BYTES} bytes`,
    };
  }
  const description = trimDescription(input.description ?? '');
  if (description === null) {
    return {
      ok: false,
      code: 'invalid_description',
      error: `description must be ≤ ${SKILL_DESCRIPTION_MAX_CHARS} chars`,
    };
  }

  try {
    const tid = await resolveTenantId(userId, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      try {
        const [row] = await db
          .insert(userSkills)
          .values({
            tenantId: tid.value,
            userId,
            name,
            slug,
            body,
            description,
          })
          .returning({ id: userSkills.id });
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
        error: 'user_skills table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'could not create skill' };
  }
}

/** Rename only; keeps body, slug, description. */
export async function renameUserSkill(
  userId: string,
  id: string,
  name: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'skill not found' };
  }
  const clean = trimName(name);
  if (!clean) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${SKILL_NAME_MIN}–${SKILL_NAME_MAX} chars`,
    };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userSkills)
        .set({ name: clean, updatedAt: new Date() })
        .where(
          and(
            eq(userSkills.id, pid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .returning({ id: userSkills.id });
      if (!updated[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not rename skill' };
  }
}

/** Replace the skill body (keeps name/slug/description). */
export async function updateUserSkillBody(
  userId: string,
  id: string,
  body: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'skill not found' };
  }
  const clean = validateBody(body);
  if (!clean) {
    return {
      ok: false,
      code: 'invalid_body',
      error: `body is required and must be ≤ ${SKILL_BODY_MAX_BYTES} bytes`,
    };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userSkills)
        .set({ body: clean, updatedAt: new Date() })
        .where(
          and(
            eq(userSkills.id, pid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .returning({ id: userSkills.id });
      if (!updated[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not update skill' };
  }
}

/** Replace the skill summary (name/description), keeping slug + body. */
export async function updateUserSkillSummary(
  userId: string,
  id: string,
  input: { name: string; description?: string },
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'skill not found' };
  }
  const clean = trimName(input.name);
  if (!clean) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${SKILL_NAME_MIN}–${SKILL_NAME_MAX} chars`,
    };
  }
  const description = trimDescription(input.description ?? '');
  if (description === null) {
    return {
      ok: false,
      code: 'invalid_description',
      error: `description must be ≤ ${SKILL_DESCRIPTION_MAX_CHARS} chars`,
    };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userSkills)
        .set({ name: clean, description, updatedAt: new Date() })
        .where(
          and(
            eq(userSkills.id, pid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .returning({ id: userSkills.id });
      if (!updated[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not update skill' };
  }
}

export async function deleteUserSkill(
  userId: string,
  id: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'skill not found' };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const deleted = await db
        .delete(userSkills)
        .where(
          and(
            eq(userSkills.id, pid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .returning({ id: userSkills.id });
      if (!deleted[0]) {
        return { ok: false, code: 'not_found', error: 'skill not found' };
      }
      return { ok: true, value: { id: pid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not delete skill' };
  }
}

/**
 * Scoped single row including body, resolved by slug (server-side injection
 * seam for phase 3). Returns null for another-user/tenant rows (no existence
 * leak). Always validates the slug charset on read so a malformed slug never
 * resolves (fail closed).
 */
export async function getSkillBySlug(
  userId: string,
  slug: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  slug: string;
  description: string;
  body: string;
} | null>> {
  const uid = userId?.trim();
  const s = slug?.trim() ?? '';
  if (!uid || !s || !SKILL_SLUG_RE.test(s)) {
    return { ok: true, value: null };
  }
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select()
        .from(userSkills)
        .where(and(eq(userSkills.slug, s), eq(userSkills.userId, uid), eq(userSkills.tenantId, tid.value)))
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
          description: row.description,
          body: row.body,
        },
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not load skill' };
  }
}

/** List summaries (no body) for discovery. */
export async function listUserSkills(
  userId: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<UserSkillSummary[]>> {
  const uid = userId?.trim();
  if (!uid) return { ok: true, value: [] };
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          id: userSkills.id,
          name: userSkills.name,
          slug: userSkills.slug,
          description: userSkills.description,
          updatedAt: userSkills.updatedAt,
        })
        .from(userSkills)
        .where(and(eq(userSkills.userId, uid), eq(userSkills.tenantId, tid.value)));
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true as const, value: rows.map(toSummary) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list skills' };
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createUserSkills(deps: UserSkillsDeps = {}) {
  return {
    createUserSkill: (input: CreateUserSkillInput, o?: UserSkillsDeps) =>
      createUserSkill(input, { ...deps, ...o }),
    renameUserSkill: (userId: string, id: string, name: string, o?: UserSkillsDeps) =>
      renameUserSkill(userId, id, name, { ...deps, ...o }),
    updateUserSkillBody: (userId: string, id: string, body: string, o?: UserSkillsDeps) =>
      updateUserSkillBody(userId, id, body, { ...deps, ...o }),
    updateUserSkillSummary: (
      userId: string,
      id: string,
      input: { name: string; description?: string },
      o?: UserSkillsDeps,
    ) => updateUserSkillSummary(userId, id, input, { ...deps, ...o }),
    deleteUserSkill: (userId: string, id: string, o?: UserSkillsDeps) =>
      deleteUserSkill(userId, id, { ...deps, ...o }),
    getSkillBySlug: (userId: string, slug: string, o?: UserSkillsDeps) =>
      getSkillBySlug(userId, slug, { ...deps, ...o }),
    listUserSkills: (userId: string, o?: UserSkillsDeps) =>
      listUserSkills(userId, { ...deps, ...o }),
  };
}
