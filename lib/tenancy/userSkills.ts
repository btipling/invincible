/**
 * Per-user agent skills CRUD + body lookup (parent #331 / phase 1 #498).
 * Server-only. Bodies are plaintext **non-secret** user content (playbooks /
 * AGENTS-md-style instruction docs) — no DEK, same policy as personas.
 * Never ship a body in a client summary.
 *
 * Skills attach per-turn via slash command (`/skill-name`, `/unskill`) as
 * session **staff of work**, NOT identity: only the **slugs** are stored in
 * session `meta.attachedSkills`; their **bodies** are re-resolved from this
 * store every turn (a mid-session edit applies next turn, a deleted skill
 * silently stops attaching). They are never snapshotted into `meta` the way a
 * locked persona snapshot is. `getSkillBySlug` is the server injection seam.
 *
 * tenantId is always derived from loadSoleMembership — never client input.
 * Every query filters tenantId + userId so a skill can never leak to another
 * user/tenant, and getSkillBySlug returns null for another-user rows (no
 * existence leak).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  userSkills,
  userSkillVersions,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { loadSoleMembership } from './soleMembership';
import { SKILL_SLUG_RE as SKILL_SLUG_RE_SRC, SKILL_VERSION_MAX, USER_ALWAYS_ON_SKILLS_MAX } from '../sessionCloudCaps';

/** Display name limits (mirror personas; generously raised in #514). */
export const SKILL_NAME_MIN = 1;
export const SKILL_NAME_MAX = 200;
/** Short summary shown by /api/skills and find_skill. */
export const SKILL_DESCRIPTION_MAX_CHARS = 2000;
/**
 * Slug charset (parent #495 locked single source of truth, shared with the
 * phase-3 slash parser AND the client-safe `lib/sessionCloudCaps.ts` seam so the
 * phase-1 `meta.attachedSkills` validator can check slugs without importing this
 * server-only module — layering: sessionStore ↛ userSkills): lowercase start;
 * digits, underscore AND hyphen allowed; ≤ 128 chars (raised from 64 in #514).
 * Hyphens are permitted so a kebab-case skill like `create-plan` stores here and
 * resolves as `/create-plan`. Do NOT copy personas' underscore-only RE.
 */
export const SKILL_SLUG_RE = SKILL_SLUG_RE_SRC;
/**
 * Skill body cap (plaintext; bounded so a single row can't balloon). Raised to
 * 4 MiB in #514 (generous, per the #512 caps direction). Skills are
 * store-hosted and re-resolved per turn; only their slugs ride `meta`, so this
 * caps the body field, not a merged meta budget.
 */
export const SKILL_BODY_MAX_BYTES = 4 * 1024 * 1024;

export type UserSkillsDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

/** UUID id shape (skills rows keyed by uuid primary key). Fail-closed on read. */
const SKILL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UserSkillsErrorCode =
  | 'invalid_name'
  | 'invalid_slug'
  | 'invalid_body'
  | 'invalid_description'
  | 'duplicate_slug'
  | 'not_found'
  | 'no_membership'
  | 'unavailable'
  | 'limit_reached';

export type UserSkillsResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserSkillsErrorCode; error: string };

/** Client-safe summary projection (no body). */
export type UserSkillSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  isAlwaysOn: boolean;
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
    isAlwaysOn: boolean;
    updatedAt: Date;
  },
): UserSkillSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isAlwaysOn: row.isAlwaysOn,
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
        // Skill + initial version row are atomic (adversarial-review L1): a
        // version-insert failure rolls back the skill insert, so a skill is
        // never left with no version snapshot.
        return await db.transaction(async (tx) => {
          const [row] = await tx
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
          await tx.insert(userSkillVersions).values({
            skillId: row.id,
            body,
            label: '',
          });
          return { ok: true as const, value: { id: row.id } };
        });
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
      // Version count gate — plan #711 phase 1. Counts all rows for this skill,
      // not just those visible in an incomplete listing. The gate runs BEFORE
      // any write (adversarial-review L1): a cap reject must never touch the
      // live body, and rollback does NOT free a slot (it inserts a row), so at
      // the cap we fail closed with an honest recovery message rather than
      // silently committing the body and dropping its version history.
      const versions = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userSkillVersions)
        .where(eq(userSkillVersions.skillId, pid));
      const count = Number(versions[0]?.count ?? 0);
      if (count >= SKILL_VERSION_MAX) {
        return {
          ok: false as const,
          code: 'invalid_body' as const,
          error: `version limit reached (${SKILL_VERSION_MAX}) — delete the skill or raise the cap`,
        };
      }

      // Body write + version insert are atomic (adversarial-review L1/L6): a
      // version-insert failure rolls back the body UPDATE so the live body and
      // the version timeline never diverge.
      return await db.transaction(async (tx) => {
        // Owner-gated read of the current live body BEFORE the UPDATE so a
        // legacy/drifted row's pre-edit body can be snapshotted below. If the
        // goal is a skill the user does not own we fail closed (not_found).
        const current = await tx
          .select({ body: userSkills.body })
          .from(userSkills)
          .where(
            and(
              eq(userSkills.id, pid),
              eq(userSkills.userId, uid),
              eq(userSkills.tenantId, tid.value),
            ),
          )
          .limit(1);
        if (!current[0]) {
          return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
        }
        const prevBody = current[0].body;

        // Pre-edit snapshot (adversarial-review L1, round 2): the timeline must
        // always hold a restorable copy of the PRE-EDIT body. create/rollback
        // keep the live body equal to the newest version row, so normally no
        // extra snapshot is needed. But a legacy pre-0012 skill (count === 0 —
        // the production population at the 0012 cutover, no GHA backfill) or any
        // drifted row has a live body that is NOT already stored as a version:
        // snapshot it BEFORE the new version so Undo stays intact. This is the
        // write-path equivalent of createUserSkill's initial row — not a data
        // backfill.
        //
        // Round 3 (L1): the capture check is order-INDEPENDENT (`WHERE body =
        // prevBody` — is the pre-edit body already stored as ANY version?)
        // instead of "is the newest row's body !== prevBody". This snapshot and
        // the new-body insert run in ONE transaction, so the Postgres `now()`
        // they share is transaction-scoped and would give BOTH rows the SAME
        // created_at; a newest-only tiebreak with no secondary key leaves
        // newest-first order unspecified (the `now` label could attach to the
        // snapshot while the live body is the edit, hiding the Restore target)
        // and can false-trigger this snapshot on the NEXT edit — burning an
        // extra cap slot. The WHERE-body check depends on no row ordering. To
        // keep newest-first deterministic anyway, the two inserts share an
        // explicit `stamped` timestamp (snapshot = stamped − 1 ms, new body =
        // stamped), so the new body is always the newest of the pair.
        const stamped = new Date();
        const already = await tx
          .select({ id: userSkillVersions.id })
          .from(userSkillVersions)
          .where(
            and(
              eq(userSkillVersions.skillId, pid),
              eq(userSkillVersions.body, prevBody),
            ),
          )
          .limit(1);
        if (already.length === 0) {
          await tx.insert(userSkillVersions).values({
            skillId: pid,
            body: prevBody,
            label: '',
            createdAt: new Date(stamped.getTime() - 1),
          });
        }

        const updated = await tx
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

        // New body row is stamped at `stamped` (strictly after any pre-edit
        // snapshot at `stamped − 1 ms`), so eager edit pairs never tie on
        // created_at and the live body is deterministically the **now** row.
        await tx.insert(userSkillVersions).values({
          skillId: pid,
          body: clean,
          label: '',
          createdAt: stamped,
        });
        return { ok: true as const, value: { id: pid } };
      });
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

/**
 * Scoped single row including body, resolved by id (server-side injection seam
 * for the `meta_skill_str_replace` patch tool — see plan for #600). Returns
 * null for another-user/tenant rows (no existence leak). Mirrors `getPersonaById`
 * and always returns the FULL stored body (server-side) regardless of the
 * model-return read cap so a patch is resolved against the actual on-disk body,
 * never a truncated read.
 */
export async function getSkillById(
  userId: string,
  id: string,
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
  const pid = id?.trim();
  if (!uid || !pid || !SKILL_ID_RE.test(pid)) {
    // Malformed / non-UUID id fails closed to null on read (a bare string would
    // otherwise hit a Postgres uuid-cast error, leaking a DB error instead of
    // the no-existence contract).
    return { ok: true, value: null };
  }
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select()
        .from(userSkills)
        .where(and(eq(userSkills.id, pid), eq(userSkills.userId, uid), eq(userSkills.tenantId, tid.value)))
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

/** Version summary projection (no body). */
export type SkillVersionSummary = {
  id: string;
  label: string;
  createdAt: Date;
};

/** Full version row including body. */
export type SkillVersion = SkillVersionSummary & { body: string };

/**
 * List version summaries (no body) for a skill, newest first.
 * Ownership-tenancy inside the skill lookup itself.
 */
export async function listSkillVersions(
  userId: string,
  skillId: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<SkillVersionSummary[]>> {
  const uid = userId?.trim();
  const sid = skillId?.trim();
  if (!uid || !sid || !SKILL_ID_RE.test(sid)) {
    return { ok: true, value: [] };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate: only list versions of skills the user owns.
      const own = await db
        .select({ id: userSkills.id })
        .from(userSkills)
        .where(
          and(
            eq(userSkills.id, sid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) return { ok: true as const, value: [] };

      const rows = await db
        .select({
          id: userSkillVersions.id,
          label: userSkillVersions.label,
          createdAt: userSkillVersions.createdAt,
        })
        .from(userSkillVersions)
        .where(eq(userSkillVersions.skillId, sid))
        .orderBy(desc(userSkillVersions.createdAt))
        .limit(SKILL_VERSION_MAX);
      return { ok: true as const, value: rows.map((r) => ({ ...r })) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skill_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list versions' };
  }
}

/**
 * Get a single version with body, by version id. Ownership-tenancy gated.
 */
export async function getSkillVersion(
  userId: string,
  skillId: string,
  versionId: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<SkillVersion | null>> {
  const uid = userId?.trim();
  const sid = skillId?.trim();
  const vid = versionId?.trim();
  if (!uid || !sid || !vid || !SKILL_ID_RE.test(sid) || !SKILL_ID_RE.test(vid)) {
    return { ok: true, value: null };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate on the skill.
      const own = await db
        .select({ id: userSkills.id })
        .from(userSkills)
        .where(
          and(
            eq(userSkills.id, sid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) return { ok: true as const, value: null };

      const rows = await db
        .select({
          id: userSkillVersions.id,
          label: userSkillVersions.label,
          body: userSkillVersions.body,
          createdAt: userSkillVersions.createdAt,
        })
        .from(userSkillVersions)
        .where(
          and(
            eq(userSkillVersions.id, vid),
            eq(userSkillVersions.skillId, sid),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true as const, value: null };
      return { ok: true as const, value: { ...row } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skill_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not load version' };
  }
}

/**
 * Rollback a skill to a specific version. Copies the version's body into
 * user_skills.body + inserts a NEW version row (rollback itself IS versioned).
 * Ownership-tenancy gated; counts against SKILL_VERSION_MAX.
 */
export async function rollbackSkill(
  userId: string,
  skillId: string,
  versionId: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<{ id: string }>> {
  const uid = userId?.trim();
  const sid = skillId?.trim();
  const vid = versionId?.trim();
  if (!uid || !sid || !vid || !SKILL_ID_RE.test(sid) || !SKILL_ID_RE.test(vid)) {
    return { ok: false, code: 'not_found', error: 'skill or version not found' };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate on the skill.
      const own = await db
        .select({ id: userSkills.id })
        .from(userSkills)
        .where(
          and(
            eq(userSkills.id, sid),
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
      }

      // Fetch the target version body.
      const ver = await db
        .select({ body: userSkillVersions.body })
        .from(userSkillVersions)
        .where(
          and(
            eq(userSkillVersions.id, vid),
            eq(userSkillVersions.skillId, sid),
          ),
        )
        .limit(1);
      if (!ver[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'version not found' };
      }
      const body = ver[0].body;

      // Version count gate BEFORE any write (adversarial-review L1): a rollback
      // at the cap must not mutate the body either. Rollback inserts a version
      // row, so it never frees a slot — fail closed with an honest message.
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userSkillVersions)
        .where(eq(userSkillVersions.skillId, sid));
      const count = Number(countRows[0]?.count ?? 0);
      if (count >= SKILL_VERSION_MAX) {
        return {
          ok: false as const,
          code: 'invalid_body' as const,
          error: `version limit reached (${SKILL_VERSION_MAX}) — delete the skill or raise the cap`,
        };
      }

      // Body update + rollback version insert are atomic (adversarial-review L1).
      return await db.transaction(async (tx) => {
        await tx
          .update(userSkills)
          .set({ body, updatedAt: new Date() })
          .where(
            and(
              eq(userSkills.id, sid),
              eq(userSkills.userId, uid),
              eq(userSkills.tenantId, tid.value),
            ),
          );

        // Insert a new version row recording the rollback.
        await tx.insert(userSkillVersions).values({
          skillId: sid,
          body,
          label: '',
        });

        return { ok: true as const, value: { id: sid } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skill_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not roll back skill' };
  }
}

/**
 * Toggle `is_always_on` on a skill (plan #720 phase 2). Enforces
 * `USER_ALWAYS_ON_SKILLS_MAX` when setting `true` — rejects at the cap so a
 * tight loop can never flip more than the cap onto the always-on set. Setting
 * `false` (clearing) is always ok.
 *
 * The cap check + update run inside a single `db.transaction` to eliminate the
 * TOCTOU window between count and write (adversarial-review #722 L1). When
 * toggling `true` on a skill that is ALREADY always-on, the call is idempotent
 * — the cap counts OTHER always-on skills (excludes self), and a re-toggle at
 * the cap succeeds rather than locking a Settings checkbox.
 */
export async function setAlwaysOn(
  userId: string,
  id: string,
  value: boolean,
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
      // Cap check + update in a single transaction (TOCTOU safety).
      return await db.transaction(async (tx) => {
        // When setting true: read current state, count OTHER always-on skills,
        // and enforce cap only when the target is NOT already true.
        if (value) {
          const row = await tx
            .select({ isAlwaysOn: userSkills.isAlwaysOn })
            .from(userSkills)
            .where(
              and(
                eq(userSkills.id, pid),
                eq(userSkills.userId, uid),
                eq(userSkills.tenantId, tid.value),
              ),
            )
            .limit(1);

          if (!row[0]) {
            return { ok: false as const, code: 'not_found' as const, error: 'skill not found' };
          }

          // Already true → idempotent (re-toggle at cap succeeds).
          if (row[0].isAlwaysOn) {
            return { ok: true, value: { id: pid } };
          }

          // Count OTHER always-on skills (exclude self).
          const counts = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(userSkills)
            .where(
              and(
                eq(userSkills.userId, uid),
                eq(userSkills.tenantId, tid.value),
                eq(userSkills.isAlwaysOn, true),
                sql`${userSkills.id} <> ${pid}`,
              ),
            );
          const current = Number(counts[0]?.count ?? 0);
          if (current >= USER_ALWAYS_ON_SKILLS_MAX) {
            return {
              ok: false as const,
              code: 'limit_reached' as const,
              error: `always-on limit reached (${USER_ALWAYS_ON_SKILLS_MAX})`,
            };
          }
        }

        const updated = await tx
          .update(userSkills)
          .set({ isAlwaysOn: value, updatedAt: new Date() })
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
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not set always-on' };
  }
}

/**
 * List slugs of the user's always-on skills (plan #720 phase 2).
 * Returns only the slugs of rows with `is_always_on = true`, ordered by
 * updatedAt desc (deterministic for the inject merge).
 */
export async function listAlwaysOnSkills(
  userId: string,
  deps: UserSkillsDeps = {},
): Promise<UserSkillsResult<string[]>> {
  const uid = userId?.trim();
  if (!uid) return { ok: true, value: [] };
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({ slug: userSkills.slug })
        .from(userSkills)
        .where(
          and(
            eq(userSkills.userId, uid),
            eq(userSkills.tenantId, tid.value),
            eq(userSkills.isAlwaysOn, true),
          ),
        )
        .orderBy(desc(userSkills.updatedAt));
      return { ok: true as const, value: rows.map((r) => r.slug) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_skills unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list always-on skills' };
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
          isAlwaysOn: userSkills.isAlwaysOn,
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
    getSkillById: (userId: string, id: string, o?: UserSkillsDeps) =>
      getSkillById(userId, id, { ...deps, ...o }),
    listSkillVersions: (userId: string, skillId: string, o?: UserSkillsDeps) =>
      listSkillVersions(userId, skillId, { ...deps, ...o }),
    getSkillVersion: (userId: string, skillId: string, versionId: string, o?: UserSkillsDeps) =>
      getSkillVersion(userId, skillId, versionId, { ...deps, ...o }),
    rollbackSkill: (userId: string, skillId: string, versionId: string, o?: UserSkillsDeps) =>
      rollbackSkill(userId, skillId, versionId, { ...deps, ...o }),
    listUserSkills: (userId: string, o?: UserSkillsDeps) =>
      listUserSkills(userId, { ...deps, ...o }),
    setAlwaysOn: (userId: string, id: string, value: boolean, o?: UserSkillsDeps) =>
      setAlwaysOn(userId, id, value, { ...deps, ...o }),
    listAlwaysOnSkills: (userId: string, o?: UserSkillsDeps) =>
      listAlwaysOnSkills(userId, { ...deps, ...o }),
  };
}
