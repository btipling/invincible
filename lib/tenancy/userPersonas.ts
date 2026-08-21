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
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  userPersonas,
  userPersonaVersions,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { loadSoleMembership } from './soleMembership';
import {
  SKILL_SLUG_RE,
  PERSONA_RECOMMENDED_SKILLS_MAX,
  PERSONA_VERSION_MAX,
} from '../sessionCloudCaps';

/** Display name limits. */
export const PERSONA_NAME_MIN = 1;
export const PERSONA_NAME_MAX = 80;
/** Pretty slug for picker/keys — lowercase start, stable-key friendly. */
export const PERSONA_SLUG_RE = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * Persona body cap (plaintext text; bounded so a single row can't balloon).
 * Persona bodies are OUT OF SCOPE of the #514 skill-cap raise and stay at
 * **16 KiB** — this is NOT the (raised to 512 KiB) `PERSONA_SNAPSHOT_MAX_BYTES`
 * in `lib/sessionCloudCaps.ts`. A persistable persona (≤ 16 KiB) still fits the
 * larger snapshot budget on first use (adversarial review #489 minor): the body
 * is snapshot-able under `meta.personaSnapshot`.
 */
export const PERSONA_BODY_MAX_BYTES = 16 * 1024;

/** UUID id shape (personas rows keyed by uuid primary key). Fail-closed on read. */
const PERSONA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  | 'unavailable'
  | 'limit_reached';

export type UserPersonasResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserPersonasErrorCode; error: string };

/** Client-safe summary projection (no body). */
export type UserPersonaSummary = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  /** Recommended skill slugs (plan #720 phase 3). Never validated on save. */
  recommendedSkillSlugs: string[];
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

function parseRecommendedSlugs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const s of value) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

function toSummary(
  row: {
    id: string;
    name: string;
    slug: string;
    isDefault: boolean;
    recommendedSkillSlugs: unknown;
    updatedAt: Date;
  },
): UserPersonaSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    recommendedSkillSlugs: parseRecommendedSlugs(row.recommendedSkillSlugs),
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
  /** Optional recommended skill slugs (plan #720 phase 3). Max PERSONA_RECOMMENDED_SKILLS_MAX. */
  recommendedSkillSlugs?: string[];
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
  // Validate recommended skill slugs (plan #720 phase 3). Slugs are NOT
  // validated against the user_skills table (a stale slug from a deleted skill
  // stays until next persona edit). Only cap and slug charset are enforced.
  const recSlugs = input.recommendedSkillSlugs ?? [];
  if (recSlugs.length > PERSONA_RECOMMENDED_SKILLS_MAX) {
    return {
      ok: false,
      code: 'limit_reached',
      error: `recommended skills max ${PERSONA_RECOMMENDED_SKILLS_MAX}`,
    };
  }
  const validRecSlugs: string[] = [];
  for (const s of recSlugs) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !validRecSlugs.includes(s)) {
      validRecSlugs.push(s);
    }
  }
  const recommendedSkillSlugs = JSON.stringify(validRecSlugs);

  try {
    const tid = await resolveTenantId(userId, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      try {
        // Persona INSERT + initial version row are atomic (plan #726, review
        // finding #2): both branches — isDefault and the common non-default path
        // (which was previously a bare `db.insert` with no transaction) — run
        // inside ONE db.transaction mirroring createUserSkill, so a version-insert
        // failure rolls back the persona insert and a persona is never left with
        // no version snapshot.
        const row = await db.transaction(async (tx) => {
          if (input.isDefault === true) {
            // Create-as-default goes through the same clear-then-set transaction as
            // setDefaultPersona (adversarial review #489 major): clear every sibling
            // (tenant+user scoped) inside the same tx, so exactly one default row can
            // ever exist for the user. A persistent partial unique index
            // (user_personas_single_default_unique) enforces this at the DB too.
            await tx
              .update(userPersonas)
              .set({ isDefault: false, updatedAt: new Date() })
              .where(
                and(
                  eq(userPersonas.userId, userId),
                  eq(userPersonas.tenantId, tid.value),
                ),
              );
          }
          const [r] = await tx
            .insert(userPersonas)
            .values({
              tenantId: tid.value,
              userId,
              name,
              slug,
              body,
              isDefault: input.isDefault === true,
              recommendedSkillSlugs: recommendedSkillSlugs as never,
            })
            .returning({ id: userPersonas.id });
          await tx.insert(userPersonaVersions).values({
            personaId: r.id,
            body,
            label: '',
          });
          return r;
        });
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
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userPersonas)
        .set({ name: clean, updatedAt: new Date() })
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
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
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Version count gate — plan #726 (mirrors skills #711 phase 1). Counts all
      // rows for this persona, not just those visible in an incomplete listing.
      // The gate runs BEFORE any write (review #722 L1 pattern): a cap reject
      // must never touch the live body, and rollback does NOT free a slot (it
      // inserts a row), so at the cap we fail closed with an honest recovery
      // message rather than silently committing the body and dropping history.
      const versions = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userPersonaVersions)
        .where(eq(userPersonaVersions.personaId, pid));
      const count = Number(versions[0]?.count ?? 0);
      if (count >= PERSONA_VERSION_MAX) {
        return {
          ok: false as const,
          code: 'invalid_body' as const,
          error: `version limit reached (${PERSONA_VERSION_MAX}) — delete the persona or raise the cap`,
        };
      }

      // Body write + version insert are atomic (review #722 L1 pattern): a
      // version-insert failure rolls back the body UPDATE so the live body and
      // the version timeline never diverge.
      return await db.transaction(async (tx) => {
        // Owner-gated read of the current live body BEFORE the UPDATE so a
        // legacy/drifted row's pre-edit body can be snapshotted below. If the
        // target is a persona the user does not own we fail closed (not_found).
        const current = await tx
          .select({ body: userPersonas.body })
          .from(userPersonas)
          .where(
            and(
              eq(userPersonas.id, pid),
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          )
          .limit(1);
        if (!current[0]) {
          return { ok: false as const, code: 'not_found' as const, error: 'persona not found' };
        }
        const prevBody = current[0].body;

        // Pre-edit snapshot (mirrors skills updateUserSkillBody): the timeline
        // must always hold a restorable copy of the PRE-EDIT body. create keeps
        // the live body equal to the newest version row, so normally no extra
        // snapshot is needed. But a legacy pre-0015 persona or any drifted row
        // has a live body NOT already stored as a version: snapshot it BEFORE
        // the new version so Restore stays intact (write-path equivalent of
        // createUserPersona's initial row — not a data backfill).
        //
        // The capture check is order-INDEPENDENT (`WHERE body = prevBody` — is
        // the pre-edit body already stored as ANY version?) instead of "is the
        // newest row's body !== prevBody". Both inserts share one transaction,
        // so Postgres `now()` would give BOTH rows the SAME created_at; a
        // newest-only tiebreak with no secondary key leaves newest-first order
        // unspecified. The two inserts share an explicit `stamped` timestamp
        // (snapshot = stamped − 1 ms, new body = stamped) so the new body is
        // always the newest of the pair — no eager-edit false-trigger, no
        // burned cap slot (test #2 vs #3 split).
        const stamped = new Date();
        const already = await tx
          .select({ id: userPersonaVersions.id })
          .from(userPersonaVersions)
          .where(
            and(
              eq(userPersonaVersions.personaId, pid),
              eq(userPersonaVersions.body, prevBody),
            ),
          )
          .limit(1);
        if (already.length === 0) {
          await tx.insert(userPersonaVersions).values({
            personaId: pid,
            body: prevBody,
            label: '',
            createdAt: new Date(stamped.getTime() - 1),
          });
        }

        const updated = await tx
          .update(userPersonas)
          .set({ body: clean, updatedAt: new Date() })
          .where(
            and(
              eq(userPersonas.id, pid),
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          )
          .returning({ id: userPersonas.id });
        if (!updated[0]) {
          return { ok: false as const, code: 'not_found' as const, error: 'persona not found' };
        }

        // New body row is stamped at `stamped` (strictly after any pre-edit
        // snapshot at `stamped − 1 ms`), so eager edit pairs never tie on
        // created_at and the live body is deterministically the **now** row.
        await tx.insert(userPersonaVersions).values({
          personaId: pid,
          body: clean,
          label: '',
          createdAt: stamped,
        });
        return { ok: true as const, value: { id: pid } };
      });
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
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const deleted = await db
        .delete(userPersonas)
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
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
  recommendedSkillSlugs: string[];
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
          recommendedSkillSlugs: parseRecommendedSlugs(row.recommendedSkillSlugs),
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

/**
 * Update a persona's recommended skill slugs (plan #720 phase 3).
 * Replaces the entire array. Enforces PERSONA_RECOMMENDED_SKILLS_MAX cap
 * and slug charset validation; does NOT validate against user_skills table.
 */
export async function updateRecommendedSlugs(
  userId: string,
  id: string,
  slugs: string[],
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = id?.trim();
  if (!uid || !pid) {
    return { ok: false, code: 'not_found', error: 'persona not found' };
  }
  if (slugs.length > PERSONA_RECOMMENDED_SKILLS_MAX) {
    return {
      ok: false,
      code: 'limit_reached',
      error: `recommended skills max ${PERSONA_RECOMMENDED_SKILLS_MAX}`,
    };
  }
  const valid: string[] = [];
  for (const s of slugs) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !valid.includes(s)) {
      valid.push(s);
    }
  }
  const value = JSON.stringify(valid);

  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userPersonas)
        .set({
          recommendedSkillSlugs: value as never,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
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
    return { ok: false, code: 'unavailable', error: 'could not update recommended slugs' };
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
          recommendedSkillSlugs: userPersonas.recommendedSkillSlugs,
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
          recommendedSkillSlugs: userPersonas.recommendedSkillSlugs,
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
        // Deterministic pick (adversarial review #489): even though the write path
        // + partial unique index guarantee a single default, an ORDER BY removes any
        // arbitrary-row dependence if read side (or a legacy row) ever diverges.
        .orderBy(desc(userPersonas.updatedAt))
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
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        const target = await tx
          .select({ id: userPersonas.id })
          .from(userPersonas)
          .where(
            and(
              eq(userPersonas.id, pid),
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          )
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
          .where(
            and(
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          );
        await tx
          .update(userPersonas)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(
            and(
              eq(userPersonas.id, pid),
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          );
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

/**
 * Clear the default flag for a user's personas (tenancy-scoped transaction).
 * No current default → no-op (still {ok}). Backs the Settings "Clear default"
 * control (phase 2 #487); distinct from delete, which also clears by removing
 * the (possibly default) row.
 */
export async function clearDefaultPersona(
  userId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ cleared: boolean }>> {
  const uid = userId?.trim();
  if (!uid) return { ok: true, value: { cleared: false } };
  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      await db
        .update(userPersonas)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        );
      return { ok: true as const, value: { cleared: true } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_personas unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not clear default persona' };
  }
}

/** Version summary projection (no body). */
export type PersonaVersionSummary = {
  id: string;
  label: string;
  createdAt: Date;
};

/** Full version row including body. */
export type PersonaVersion = PersonaVersionSummary & { body: string };

/**
 * List version summaries (no body) for a persona, newest first.
 * Ownership-tenancy inside the persona lookup itself.
 */
export async function listPersonaVersions(
  userId: string,
  personaId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<PersonaVersionSummary[]>> {
  const uid = userId?.trim();
  const pid = personaId?.trim();
  if (!uid || !pid || !PERSONA_ID_RE.test(pid)) {
    return { ok: true, value: [] };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate: only list versions of personas the user owns.
      const own = await db
        .select({ id: userPersonas.id })
        .from(userPersonas)
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) return { ok: true as const, value: [] };

      const rows = await db
        .select({
          id: userPersonaVersions.id,
          label: userPersonaVersions.label,
          createdAt: userPersonaVersions.createdAt,
        })
        .from(userPersonaVersions)
        .where(eq(userPersonaVersions.personaId, pid))
        .orderBy(desc(userPersonaVersions.createdAt))
        .limit(PERSONA_VERSION_MAX);
      return { ok: true as const, value: rows.map((r) => ({ ...r })) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_persona_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list versions' };
  }
}

/**
 * Get a single version with body, by version id. Ownership-tenancy gated.
 */
export async function getPersonaVersion(
  userId: string,
  personaId: string,
  versionId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<PersonaVersion | null>> {
  const uid = userId?.trim();
  const pid = personaId?.trim();
  const vid = versionId?.trim();
  if (!uid || !pid || !vid || !PERSONA_ID_RE.test(pid) || !PERSONA_ID_RE.test(vid)) {
    return { ok: true, value: null };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate on the persona.
      const own = await db
        .select({ id: userPersonas.id })
        .from(userPersonas)
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) return { ok: true as const, value: null };

      const rows = await db
        .select({
          id: userPersonaVersions.id,
          label: userPersonaVersions.label,
          body: userPersonaVersions.body,
          createdAt: userPersonaVersions.createdAt,
        })
        .from(userPersonaVersions)
        .where(
          and(
            eq(userPersonaVersions.id, vid),
            eq(userPersonaVersions.personaId, pid),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true as const, value: null };
      return { ok: true as const, value: { ...row } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_persona_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not load version' };
  }
}

/**
 * Rollback a persona to a specific version. Copies the version's body into
 * user_personas.body + inserts a NEW version row (rollback itself IS versioned).
 * Ownership-tenancy gated; counts against PERSONA_VERSION_MAX.
 */
export async function rollbackPersona(
  userId: string,
  personaId: string,
  versionId: string,
  deps: UserPersonasDeps = {},
): Promise<UserPersonasResult<{ id: string }>> {
  const uid = userId?.trim();
  const pid = personaId?.trim();
  const vid = versionId?.trim();
  if (!uid || !pid || !vid || !PERSONA_ID_RE.test(pid) || !PERSONA_ID_RE.test(vid)) {
    return { ok: false, code: 'not_found', error: 'persona or version not found' };
  }
  const tid = await resolveTenantId(uid, deps);
  if (!tid.ok) return tid;

  try {
    return await withDb(deps, async (db) => {
      // Ownership gate on the persona.
      const own = await db
        .select({ id: userPersonas.id })
        .from(userPersonas)
        .where(
          and(
            eq(userPersonas.id, pid),
            eq(userPersonas.userId, uid),
            eq(userPersonas.tenantId, tid.value),
          ),
        )
        .limit(1);
      if (!own[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'persona not found' };
      }

      // Fetch the target version body.
      const ver = await db
        .select({ body: userPersonaVersions.body })
        .from(userPersonaVersions)
        .where(
          and(
            eq(userPersonaVersions.id, vid),
            eq(userPersonaVersions.personaId, pid),
          ),
        )
        .limit(1);
      if (!ver[0]) {
        return { ok: false as const, code: 'not_found' as const, error: 'version not found' };
      }
      const body = ver[0].body;

      // Version count gate BEFORE any write (review #722 L1 pattern): a rollback
      // at the cap must not mutate the body either. Rollback inserts a version
      // row, so it never frees a slot — fail closed with an honest message.
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(userPersonaVersions)
        .where(eq(userPersonaVersions.personaId, pid));
      const count = Number(countRows[0]?.count ?? 0);
      if (count >= PERSONA_VERSION_MAX) {
        return {
          ok: false as const,
          code: 'invalid_body' as const,
          error: `version limit reached (${PERSONA_VERSION_MAX}) — delete the persona or raise the cap`,
        };
      }

      // Body update + rollback version insert are atomic (review #722 L1 pattern).
      return await db.transaction(async (tx) => {
        await tx
          .update(userPersonas)
          .set({ body, updatedAt: new Date() })
          .where(
            and(
              eq(userPersonas.id, pid),
              eq(userPersonas.userId, uid),
              eq(userPersonas.tenantId, tid.value),
            ),
          );

        // Insert a new version row recording the rollback.
        await tx.insert(userPersonaVersions).values({
          personaId: pid,
          body,
          label: '',
        });

        return { ok: true as const, value: { id: pid } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'user_persona_versions unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not roll back persona' };
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
    clearDefaultPersona: (userId: string, o?: UserPersonasDeps) =>
      clearDefaultPersona(userId, { ...deps, ...o }),
    updateRecommendedSlugs: (userId: string, id: string, slugs: string[], o?: UserPersonasDeps) =>
      updateRecommendedSlugs(userId, id, slugs, { ...deps, ...o }),
    listPersonaVersions: (userId: string, personaId: string, o?: UserPersonasDeps) =>
      listPersonaVersions(userId, personaId, { ...deps, ...o }),
    getPersonaVersion: (userId: string, personaId: string, versionId: string, o?: UserPersonasDeps) =>
      getPersonaVersion(userId, personaId, versionId, { ...deps, ...o }),
    rollbackPersona: (userId: string, personaId: string, versionId: string, o?: UserPersonasDeps) =>
      rollbackPersona(userId, personaId, versionId, { ...deps, ...o }),
  };
}
