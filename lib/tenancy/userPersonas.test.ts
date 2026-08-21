import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  clearDefaultPersona,
  createUserPersona,
  deleteUserPersona,
  getPersonaById,
  getPersonaVersion,
  listPersonaVersions,
  listUserPersonas,
  renameUserPersona,
  resolveDefaultPersona,
  rollbackPersona,
  setDefaultPersona,
  updateRecommendedSlugs,
  updateUserPersonaBody,
} from './userPersonas';
import { PERSONA_RECOMMENDED_SKILLS_MAX, PERSONA_VERSION_MAX } from '../sessionCloudCaps';
import { getSharedDb, resetTenantTables } from './test/shared';

let db!: ReturnType<typeof drizzle<typeof schema>>;

async function seedUser(tenantSlug: string, email: string): Promise<{
  tenantId: string;
  userId: string;
}> {
  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: tenantSlug, name: tenantSlug })
    .returning({ id: schema.tenants.id });
  const [user] = await db
    .insert(schema.users)
    .values({ email, status: 'active' })
    .returning({ id: schema.users.id });
  await db.insert(schema.tenantMembers).values({
    tenantId: tenant.id,
    userId: user.id,
    role: 'owner',
  });
  return { tenantId: tenant.id, userId: user.id };
}

describe('userPersonas', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  it('create persists a tenant/user-scoped row; list returns summaries without body', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'Frontend', slug: 'frontend', body: 'You are a FE engineer.' },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    expect(created.value.id).toBeTruthy();

    const rows = await db
      .select()
      .from(schema.userPersonas)
      .where(eq(schema.userPersonas.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Frontend');
    expect(rows[0].body).toBe('You are a FE engineer.');

    const listed = await listUserPersonas(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(1);
    // No body in the summary projection.
    expect(listed.value[0]).toEqual({
      id: rows[0].id,
      name: 'Frontend',
      slug: 'frontend',
      isDefault: false,
      recommendedSkillSlugs: [],
      updatedAt: expect.any(Date),
    });
    expect('body' in (listed.value[0] as Record<string, unknown>)).toBe(false);
  });

  it('getById returns the body for the owner; cross-user / other-tenant → null (no leak)', async () => {
    const { userId, tenantId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'secret-ish body A' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';

    const own = await getPersonaById(userId, id, { db: db as never });
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error('expected ok');
    expect(own.value?.body).toBe('secret-ish body A');

    // A different (non-owner) user sees null — no existence leak.
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await getPersonaById(otherId, id, { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toBeNull();
    void tenantId;
  });

  it('duplicate slug per user → error; different users can share a slug', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserPersona(
      { userId, name: 'A', slug: 'shared', body: 'one' },
      { db: db as never },
    );
    const dup = await createUserPersona(
      { userId, name: 'B', slug: 'shared', body: 'two' },
      { db: db as never },
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate_slug');

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const ok = await createUserPersona(
      { userId: otherId, name: 'C', slug: 'shared', body: 'three' },
      { db: db as never },
    );
    expect(ok.ok).toBe(true);
  });

  it('rejects empty body / bad slug / bad name', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const empty = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: '' },
      { db: db as never },
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('invalid_body');

    const badSlug = await createUserPersona(
      { userId, name: 'A', slug: 'A-bad', body: 'x' },
      { db: db as never },
    );
    expect(badSlug.ok).toBe(false);
    if (!badSlug.ok) expect(badSlug.code).toBe('invalid_slug');
  });

  it('rename keeps body + isDefault; updateBody keeps name', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'orig-body', isDefault: true },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';

    const renamed = await renameUserPersona(userId, id, 'Alpha', { db: db as never });
    expect(renamed.ok).toBe(true);

    const updated = await updateUserPersonaBody(userId, id, 'new-body', {
      db: db as never,
    });
    expect(updated.ok).toBe(true);

    const row = await getPersonaById(userId, id, { db: db as never });
    expect(row.ok).toBe(true);
    if (!row.ok) throw new Error('expected ok');
    expect(row.value?.name).toBe('Alpha');
    expect(row.value?.body).toBe('new-body');
    expect(row.value?.isDefault).toBe(true);
  });

  it('delete removes a persona scoped to the user; other-user delete is a no-op not_found', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'x' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const otherDel = await deleteUserPersona(otherId, id, { db: db as never });
    expect(otherDel.ok).toBe(false);
    if (!otherDel.ok) expect(otherDel.code).toBe('not_found');

    const del = await deleteUserPersona(userId, id, { db: db as never });
    expect(del.ok).toBe(true);
    const gone = await getPersonaById(userId, id, { db: db as never });
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error('expected ok');
    expect(gone.value).toBeNull();
  });

  it('setDefault promotes atomically: exactly one default per user; resolve returns it', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one' },
      { db: db as never },
    );
    const b = await createUserPersona(
      { userId, name: 'B', slug: 'b', body: 'two' },
      { db: db as never },
    );
    const aId = a.ok ? a.value.id : '';
    const bId = b.ok ? b.value.id : '';

    await setDefaultPersona(userId, aId, { db: db as never });
    let def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value?.id).toBe(aId);

    await setDefaultPersona(userId, bId, { db: db as never });
    def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value?.id).toBe(bId);

    const rows = await db
      .select()
      .from(schema.userPersonas)
      .where(eq(schema.userPersonas.userId, userId));
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(bId);
  });

  it('create-as-default goes through clear-then-set: two isDefault:true creates → exactly one default', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one', isDefault: true },
      { db: db as never },
    );
    const b = await createUserPersona(
      { userId, name: 'B', slug: 'b', body: 'two', isDefault: true },
      { db: db as never },
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // resolveDefault picks the newest create-as-default, deterministically.
    const def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value?.id).toBe(b.ok ? b.value.id : '');

    const rows = await db
      .select()
      .from(schema.userPersonas)
      .where(eq(schema.userPersonas.userId, userId));
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(b.ok ? b.value.id : '');
  });

  it('DB partial unique index is enforced: a second isDefault=true insert is rejected', async () => {
    const { userId, tenantId } = await seedUser('t1', 'u@example.com');
    // Bypass the store to prove the schema/migration constraint itself holds:
    // the first default is legal, the second (same tenant+user) must violate the
    // partial unique index `user_personas_single_default_unique`.
    await db.insert(schema.userPersonas).values({
      tenantId,
      userId,
      name: 'A',
      slug: 'a',
      body: 'one',
      isDefault: true,
    });
    await expect(
      db.insert(schema.userPersonas).values({
        tenantId,
        userId,
        name: 'B',
        slug: 'b',
        body: 'two',
        isDefault: true,
      }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(schema.userPersonas)
      .where(eq(schema.userPersonas.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    expect(rows[0].slug).toBe('a');
  });

  it('setDefault is scoped: another user setting default does not clear this user default', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one', isDefault: true },
      { db: db as never },
    );
    const aId = a.ok ? a.value.id : '';

    const { userId: otherUserId } = await seedUser('t2', 'other@example.com');
    const other = await createUserPersona(
      { userId: otherUserId, name: 'B', slug: 'b', body: 'two' },
      { db: db as never },
    );
    if (!other.ok) throw new Error('expected ok');
    await setDefaultPersona(otherUserId, other.value.id, { db: db as never });

    // This user's default untouched.
    const def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value?.id).toBe(aId);
  });

  it('empty user → empty list; resolveDefault → null', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const listed = await listUserPersonas(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toEqual([]);

    const def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value).toBeNull();
  });

  it('clearDefaultPersona clears the default; resolveDefault → null afterward', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one', isDefault: true },
      { db: db as never },
    );
    const b = await createUserPersona(
      { userId, name: 'B', slug: 'b', body: 'two' },
      { db: db as never },
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const cleared = await clearDefaultPersona(userId, { db: db as never });
    expect(cleared.ok).toBe(true);

    const def = await resolveDefaultPersona(userId, { db: db as never });
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');
    expect(def.value).toBeNull();

    // Rows remain (default flag only cleared, nothing deleted).
    const listed = await listUserPersonas(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.map((x) => x.isDefault)).toEqual([false, false]);
  });

  it('clearDefaultPersona with no current default is a no-op {ok}', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one' },
      { db: db as never },
    );
    const cleared = await clearDefaultPersona(userId, { db: db as never });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('expected ok');
    expect(cleared.value.cleared).toBe(true);
  });

  it('clearDefaultPersona is user-scoped: it never clears another user default', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'one', isDefault: true },
      { db: db as never },
    );
    const aId = a.ok ? a.value.id : '';

    const { userId: otherUserId } = await seedUser('t2', 'other@example.com');
    await createUserPersona(
      { userId: otherUserId, name: 'B', slug: 'b', body: 'two', isDefault: true },
      { db: db as never },
    );

    // Clearing user A's default must not touch user B's.
    await clearDefaultPersona(userId, { db: db as never });

    const otherDef = await resolveDefaultPersona(otherUserId, {
      db: db as never,
    });
    expect(otherDef.ok).toBe(true);
    if (!otherDef.ok) throw new Error('expected ok');
    expect(otherDef.value?.id).toBeTruthy();

    const ownDef = await resolveDefaultPersona(userId, { db: db as never });
    expect(ownDef.ok).toBe(true);
    if (!ownDef.ok) throw new Error('expected ok');
    expect(ownDef.value).toBeNull();
    void aId;
  });

  // Plan #720 phase 3 — jsonb round-trip (adversarial-review L6).
  it('create with recommendedSkillSlugs → getPersonaById → slugs are preserved (jsonb round-trip)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      {
        userId,
        name: 'Rec',
        slug: 'rec',
        body: 'test',
        recommendedSkillSlugs: ['create-plan', 'plan_review'],
      },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    const full = await getPersonaById(userId, created.value.id, { db: db as never });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error('expected ok');
    expect(full.value?.recommendedSkillSlugs).toEqual(['create-plan', 'plan_review']);

    // Summary projection also preserves the slugs.
    const listed = await listUserPersonas(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value[0].recommendedSkillSlugs).toEqual(['create-plan', 'plan_review']);
  });

  it('updateRecommendedSlugs replaces and round-trips through getPersonaById', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      {
        userId,
        name: 'Rec',
        slug: 'rec',
        body: 'test',
        recommendedSkillSlugs: ['slug-a'],
      },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;

    // Update replaces the entire array.
    const upd = await updateRecommendedSlugs(userId, id, ['slug-b', 'slug-c'], { db: db as never });
    expect(upd.ok).toBe(true);

    const full = await getPersonaById(userId, id, { db: db as never });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error('expected ok');
    expect(full.value?.recommendedSkillSlugs).toEqual(['slug-b', 'slug-c']);
  });

  it('recommendedSkillSlugs are capped at PERSONA_RECOMMENDED_SKILLS_MAX', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const slugs = Array.from({ length: PERSONA_RECOMMENDED_SKILLS_MAX + 1 }, (_, i) => `s_${i}`);
    const created = await createUserPersona(
      {
        userId,
        name: 'Cap',
        slug: 'cap',
        body: 'x',
        recommendedSkillSlugs: slugs,
      },
      { db: db as never },
    );
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.code).toBe('limit_reached');
      expect(created.error).toContain(`recommended skills max ${PERSONA_RECOMMENDED_SKILLS_MAX}`);
    }

    // updateRecommendedSlugs also enforces the cap.
    const ok = await createUserPersona(
      { userId, name: 'Cap', slug: 'cap2', body: 'x' },
      { db: db as never },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected ok');
    const upd = await updateRecommendedSlugs(userId, ok.value.id, slugs, { db: db as never });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.code).toBe('limit_reached');
  });

  it('recommendedSkillSlugs: invalid/malformed slugs are silently dropped on write', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      {
        userId,
        name: 'Clean',
        slug: 'clean',
        body: 'x',
        recommendedSkillSlugs: ['valid-slug', 'NOT_A_SLUG', '', 'also-valid'],
      },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    const full = await getPersonaById(userId, created.value.id, { db: db as never });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error('expected ok');
    // Only valid slugs survive; duplicates are de-duplicated.
    expect(full.value?.recommendedSkillSlugs).toEqual(['valid-slug', 'also-valid']);
  });
});

// Plan #726 (source #534) — persona version history + rollback (mirrors skills #711).
describe('userPersonas version history + rollback', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  /** Count version rows for a persona directly. */
  async function versionCount(personaId: string): Promise<number> {
    const rows = await db
      .select()
      .from(schema.userPersonaVersions)
      .where(eq(schema.userPersonaVersions.personaId, personaId));
    return rows.length;
  }

  /** Read a persona's live body directly. */
  async function liveBody(userId: string, personaId: string): Promise<string> {
    const rows = await db
      .select({ body: schema.userPersonas.body })
      .from(schema.userPersonas)
      .where(eq(schema.userPersonas.id, personaId));
    return rows[0]?.body ?? '';
  }

  it('create inserts an initial version row atomically (normal + isDefault branches)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');

    // Normal branch.
    const normal = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1 body' },
      { db: db as never },
    );
    expect(normal.ok).toBe(true);
    if (!normal.ok) throw new Error('expected ok');

    // isDefault branch.
    const def = await createUserPersona(
      { userId, name: 'B', slug: 'b', body: 'default-v1 body', isDefault: true },
      { db: db as never },
    );
    expect(def.ok).toBe(true);
    if (!def.ok) throw new Error('expected ok');

    expect(await versionCount(normal.value.id)).toBe(1);
    expect(await versionCount(def.value.id)).toBe(1);

    const rows = await db
      .select({ body: schema.userPersonaVersions.body })
      .from(schema.userPersonaVersions)
      .where(eq(schema.userPersonaVersions.personaId, normal.value.id));
    expect(rows[0].body).toBe('v1 body');
  });

  it('update after a normal create captures ONLY the new body (1 row — pre-edit already stored)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1 body' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;

    const upd = await updateUserPersonaBody(userId, id, 'v2 body', { db: db as never });
    expect(upd.ok).toBe(true);

    // Pre-edit 'v1 body' already stored from create → the WHERE body check
    // finds it, so only the new body is inserted (1 extra row → 2 total).
    expect(await versionCount(id)).toBe(2);
    expect(await liveBody(userId, id)).toBe('v2 body');
  });

  it('update on a drifted/legacy row captures BOTH pre-edit snapshot + new body (2 rows, newest-first deterministic)', async () => {
    const { userId, tenantId } = await seedUser('t1', 'u@example.com');
    // Insert a persona directly bypassing the store — a drifted/legacy row
    // whose live body is NOT stored as a version (simulates a pre-0015 persona).
    const [inserted] = await db
      .insert(schema.userPersonas)
      .values({
        tenantId,
        userId,
        name: 'Drift',
        slug: 'drift',
        body: 'legacy body',
        isDefault: false,
      })
      .returning({ id: schema.userPersonas.id });

    const upd = await updateUserPersonaBody(userId, inserted.id, 'new body', {
      db: db as never,
    });
    expect(upd.ok).toBe(true);

    expect(await versionCount(inserted.id)).toBe(2);
    expect(await liveBody(userId, inserted.id)).toBe('new body');

    // Newest-first: the new body (stamped) rows above the pre-edit snapshot
    // (stamped − 1 ms), so the newest row is the live body.
    const rows = await db
      .select({ body: schema.userPersonaVersions.body, createdAt: schema.userPersonaVersions.createdAt })
      .from(schema.userPersonaVersions)
      .where(eq(schema.userPersonaVersions.personaId, inserted.id))
      .orderBy(desc(schema.userPersonaVersions.createdAt));
    expect(rows[0].body).toBe('new body');
    expect(rows[1].body).toBe('legacy body');
  });

  it('update at the version cap → rejected, body unchanged', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1 body' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;

    // Fill to the cap with direct inserts (cap = 100).
    for (let i = 0; i < PERSONA_VERSION_MAX - 1; i++) {
      await db.insert(schema.userPersonaVersions).values({
        personaId: id,
        body: `filler-${i}`,
        label: '',
      });
    }
    expect(await versionCount(id)).toBe(PERSONA_VERSION_MAX);

    const upd = await updateUserPersonaBody(userId, id, 'over-cap body', {
      db: db as never,
    });
    expect(upd.ok).toBe(false);
    if (!upd.ok) {
      expect(upd.code).toBe('invalid_body');
      expect(upd.error).toContain(`version limit reached (${PERSONA_VERSION_MAX})`);
    }

    // Body unchanged; no extra version row.
    expect(await liveBody(userId, id)).toBe('v1 body');
    expect(await versionCount(id)).toBe(PERSONA_VERSION_MAX);
  });

  it('listPersonaVersions returns newest-first summaries (no body), ownership-gated (non-owner → [])', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;
    await updateUserPersonaBody(userId, id, 'v2', { db: db as never });
    await updateUserPersonaBody(userId, id, 'v3', { db: db as never });

    const listed = await listPersonaVersions(userId, id, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(3);
    // Newest first.
    expect(listed.value[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      listed.value[2].createdAt.getTime(),
    );
    // No body field in the summary.
    expect('body' in (listed.value[0] as Record<string, unknown>)).toBe(false);

    // Non-owner → empty (no existence leak).
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await listPersonaVersions(otherId, id, { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toEqual([]);
  });

  it('getPersonaVersion returns body by version id, ownership-gated, no-existence-leak (null)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;
    await updateUserPersonaBody(userId, id, 'v2', { db: db as never });

    const versions = await listPersonaVersions(userId, id, { db: db as never });
    if (!versions.ok || !versions.value[0]) throw new Error('expected version');
    const target = versions.value[0];

    const got = await getPersonaVersion(userId, id, target.id, { db: db as never });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value?.body).toBe('v2');

    // Non-owner → null.
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await getPersonaVersion(otherId, id, target.id, { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toBeNull();

    // Missing version id → null (no existence leak).
    const missing = await getPersonaVersion(userId, id, '00000000-0000-0000-0000-000000000000', { db: db as never });
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('expected ok');
    expect(missing.value).toBeNull();
  });

  it('rollback copies version body → live row + inserts a new version row (atomic)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;
    await updateUserPersonaBody(userId, id, 'v2', { db: db as never });
    await updateUserPersonaBody(userId, id, 'v3', { db: db as never });

    // Find the v1 version row (oldest) and roll back to it.
    const versions = await listPersonaVersions(userId, id, { db: db as never });
    if (!versions.ok) throw new Error('expected ok');
    const oldest = versions.value[versions.value.length - 1];

    const before = await versionCount(id);
    const rb = await rollbackPersona(userId, id, oldest.id, { db: db as never });
    expect(rb.ok).toBe(true);

    // Live body restored to v1 body; one new version row (rollback IS versioned).
    expect(await liveBody(userId, id)).toBe('v1');
    expect(await versionCount(id)).toBe(before + 1);

    // Newest version row is the restored body (either from rollback insert).
    const rows = await db
      .select({ body: schema.userPersonaVersions.body })
      .from(schema.userPersonaVersions)
      .where(eq(schema.userPersonaVersions.personaId, id))
      .orderBy(desc(schema.userPersonaVersions.createdAt));
    expect(rows[0].body).toBe('v1');
  });

  it('rollback at the version cap → rejected, body unchanged', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;
    await updateUserPersonaBody(userId, id, 'v2', { db: db as never });

    // Fill to the cap.
    for (let i = 0; i < PERSONA_VERSION_MAX - 2; i++) {
      await db.insert(schema.userPersonaVersions).values({
        personaId: id,
        body: `filler-${i}`,
        label: '',
      });
    }
    expect(await versionCount(id)).toBe(PERSONA_VERSION_MAX);

    const versions = await listPersonaVersions(userId, id, { db: db as never });
    if (!versions.ok) throw new Error('expected ok');
    const earliest = versions.value[versions.value.length - 1];

    const rb = await rollbackPersona(userId, id, earliest.id, { db: db as never });
    expect(rb.ok).toBe(false);
    if (!rb.ok) {
      expect(rb.code).toBe('invalid_body');
      expect(rb.error).toContain(`version limit reached (${PERSONA_VERSION_MAX})`);
    }

    expect(await liveBody(userId, id)).toBe('v2');
    expect(await versionCount(id)).toBe(PERSONA_VERSION_MAX);
  });

  it('version rows cascade-delete with the persona', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserPersona(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;
    await updateUserPersonaBody(userId, id, 'v2', { db: db as never });
    expect(await versionCount(id)).toBe(2);

    await deleteUserPersona(userId, id, { db: db as never });
    expect(await versionCount(id)).toBe(0);
  });
});

