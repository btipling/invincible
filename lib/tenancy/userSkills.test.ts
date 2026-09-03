import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  createUserSkill,
  deleteUserSkill,
  getSkillById,
  getSkillBySlug,
  skillExistsBySlug,
  skillExistsBySlugs,
  getSkillVersion,
  listAlwaysOnSkills,
  listSkillVersions,
  listUserSkills,
  listUserSkillsBySlugs,
  renameUserSkill,
  rollbackSkill,
  setAlwaysOn,
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  updateUserSkillBody,
  updateUserSkillSummary,
} from './userSkills';
import {
  HARNESS_SESSION_MAX_ATTACHED_SKILLS,
  SKILL_VERSION_MAX,
  USER_ALWAYS_ON_SKILLS_MAX,
} from '../sessionCloudCaps';
import {
  createIsolatedTestDb,
  getSharedDb,
  resetTenantTables,
} from './test/shared';

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

describe('userSkills', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  it('create persists a tenant/user-scoped row; list returns summaries WITHOUT body', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      {
        userId,
        name: 'Create plan',
        slug: 'create-plan',
        description: 'Writes a plan issue.',
        body: 'You are the plan author.',
      },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    expect(created.value.id).toBeTruthy();

    const rows = await db
      .select()
      .from(schema.userSkills)
      .where(eq(schema.userSkills.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Create plan');
    expect(rows[0].slug).toBe('create-plan');
    expect(rows[0].description).toBe('Writes a plan issue.');
    expect(rows[0].body).toBe('You are the plan author.');

    const listed = await listUserSkills(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(1);
    // Summary projection: no body.
    expect(listed.value[0]).toEqual({
      id: rows[0].id,
      name: 'Create plan',
      slug: 'create-plan',
      description: 'Writes a plan issue.',
      isAlwaysOn: false,
      updatedAt: expect.any(Date),
    });
    expect('body' in (listed.value[0] as Record<string, unknown>)).toBe(false);
  });

  it('accepts a hyphenated kebab-case slug (create-plan) — parent-locked charset allows hyphens', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'Create plan', slug: 'create-plan', body: 'body' },
      { db: db as never },
    );
    expect(created.ok).toBe(true);

    const bySlug = await getSkillBySlug(userId, 'create-plan', {
      db: db as never,
    });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.body).toBe('body');
  });

  it('rejects invalid slugs (uppercase start, leading hyphen) — invalid_slug', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const upper = await createUserSkill(
      { userId, name: 'A', slug: 'Bad', body: 'x' },
      { db: db as never },
    );
    expect(upper.ok).toBe(false);
    if (!upper.ok) expect(upper.code).toBe('invalid_slug');

    const leadingHyphen = await createUserSkill(
      { userId, name: 'A', slug: '-bad', body: 'x' },
      { db: db as never },
    );
    expect(leadingHyphen.ok).toBe(false);
    if (!leadingHyphen.ok) expect(leadingHyphen.code).toBe('invalid_slug');
  });

  it('duplicate slug per user → duplicate_slug; different users can share a slug', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'A', slug: 'shared', body: 'one' },
      { db: db as never },
    );
    const dup = await createUserSkill(
      { userId, name: 'B', slug: 'shared', body: 'two' },
      { db: db as never },
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate_slug');

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const ok = await createUserSkill(
      { userId: otherId, name: 'C', slug: 'shared', body: 'three' },
      { db: db as never },
    );
    expect(ok.ok).toBe(true);
  });

  it('getSkillBySlug returns the body for the owner; other-user / foreign slug → null (no leak)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'body-A' },
      { db: db as never },
    );
    expect(created.ok).toBe(true);

    const own = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error('expected ok');
    expect(own.value?.body).toBe('body-A');

    // Another user (same or different tenant) sees null — no existence leak.
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await getSkillBySlug(otherId, 'a', { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toBeNull();

    // A slug-shaped-but-unstored slug is null too.
    const missing = await getSkillBySlug(userId, 'does-not-exist', {
      db: db as never,
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('expected ok');
    expect(missing.value).toBeNull();

    // Malformed slug fails closed on read (never resolves).
    const malformed = await getSkillBySlug(userId, 'Not-A-Slug', {
      db: db as never,
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) throw new Error('expected ok');
    expect(malformed.value).toBeNull();
  });

  it('skillExistsBySlug is slug-only (no body): owner true, other-user/missing/malformed false', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'body-A-must-not-hydrate' },
      { db: db as never },
    );
    expect(created.ok).toBe(true);

    const own = await skillExistsBySlug(userId, 'a', { db: db as never });
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error('expected ok');
    expect(own.value).toBe(true);
    // Result is a boolean — no body field to leak a 4 MiB playbook.
    expect(typeof own.value).toBe('boolean');

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await skillExistsBySlug(otherId, 'a', { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toBe(false);

    const missing = await skillExistsBySlug(userId, 'does-not-exist', {
      db: db as never,
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('expected ok');
    expect(missing.value).toBe(false);

    const malformed = await skillExistsBySlug(userId, 'Not-A-Slug', {
      db: db as never,
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) throw new Error('expected ok');
    expect(malformed.value).toBe(false);
  });

  it('skillExistsBySlugs is one IN (no body): owner present, other-user/missing/malformed omitted', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'body-A-must-not-hydrate' },
      { db: db as never },
    );
    await createUserSkill(
      { userId, name: 'B', slug: 'b', body: 'body-B-must-not-hydrate' },
      { db: db as never },
    );

    const own = await skillExistsBySlugs(userId, ['b', 'a', 'a', 'missing', 'Not-A-Slug'], {
      db: db as never,
    });
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error('expected ok');
    expect([...own.value].sort()).toEqual(['a', 'b']);
    expect(own.value.every((s) => typeof s === 'string')).toBe(true);

    const empty = await skillExistsBySlugs(userId, [], { db: db as never });
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error('expected ok');
    expect(empty.value).toEqual([]);

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await skillExistsBySlugs(otherId, ['a', 'b'], {
      db: db as never,
    });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toEqual([]);
  });

  it('skillExistsBySlugs slices IN to sticky+always-on+1 (keeps first N)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'First', slug: 's0', body: 'x' },
      { db: db as never },
    );
    const inCapSlug = `s${HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX}`;
    const droppedSlug = `s${HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX + 1}`;
    await createUserSkill(
      { userId, name: 'InCap', slug: inCapSlug, body: 'x' },
      { db: db as never },
    );
    await createUserSkill(
      { userId, name: 'Dropped', slug: droppedSlug, body: 'x' },
      { db: db as never },
    );
    const slugs = Array.from(
      { length: HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX + 2 },
      (_, i) => `s${i}`,
    );
    const listed = await skillExistsBySlugs(userId, slugs, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect([...listed.value].sort()).toEqual(['s0', inCapSlug].sort());
    expect(listed.value).not.toContain(droppedSlug);
  });

  it('getSkillById returns the FULL body for the owner; other-user / foreign id → null (no leak)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      {
        userId,
        name: 'A',
        slug: 'a',
        body: 'full-body-with-marker',
      },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');
    const id = created.value.id;

    const own = await getSkillById(userId, id, { db: db as never });
    expect(own.ok).toBe(true);
    if (!own.ok) throw new Error('expected ok');
    expect(own.value?.id).toBe(id);
    expect(own.value?.body).toBe('full-body-with-marker');

    // Another user (same or different tenant) sees null — no existence leak.
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await getSkillById(otherId, id, { db: db as never });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toBeNull();

    // An unstored id is null too.
    const missing = await getSkillById(
      userId,
      '00000000-0000-0000-0000-000000000000',
      { db: db as never },
    );
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('expected ok');
    expect(missing.value).toBeNull();

    // A malformed / non-UUID id fails closed to null on read (never a Postgres
    // uuid-cast DB error leak).
    const malformed = await getSkillById(userId, 'not-a-uuid', {
      db: db as never,
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) throw new Error('expected ok');
    expect(malformed.value).toBeNull();

    // Empty id / empty userId fail closed to null (never a partial-row leak).
    const emptyId = await getSkillById(userId, '', { db: db as never });
    expect(emptyId.ok).toBe(true);
    if (!emptyId.ok) throw new Error('expected ok');
    expect(emptyId.value).toBeNull();
    const emptyUser = await getSkillById('', id, { db: db as never });
    expect(emptyUser.ok).toBe(true);
    if (!emptyUser.ok) throw new Error('expected ok');
    expect(emptyUser.value).toBeNull();
  });

  it('rename keeps body; updateBody keeps name; updateSummary sets name+description', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'orig-body' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');

    const renamed = await renameUserSkill(userId, id, 'Alpha', { db: db as never });
    expect(renamed.ok).toBe(true);

    const updated = await updateUserSkillBody(userId, id, 'new-body', {
      db: db as never,
    });
    expect(updated.ok).toBe(true);

    const summarized = await updateUserSkillSummary(
      userId,
      id,
      { name: 'Alpha', description: 'new summary' },
      { db: db as never },
    );
    expect(summarized.ok).toBe(true);

    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.name).toBe('Alpha');
    expect(bySlug.value?.description).toBe('new summary');
    expect(bySlug.value?.body).toBe('new-body');
  });

  it('delete removes a skill scoped to the user; other-user delete is a no-op not_found', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'x' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const otherDel = await deleteUserSkill(otherId, id, { db: db as never });
    expect(otherDel.ok).toBe(false);
    if (!otherDel.ok) expect(otherDel.code).toBe('not_found');

    const del = await deleteUserSkill(userId, id, { db: db as never });
    expect(del.ok).toBe(true);

    const gone = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error('expected ok');
    expect(gone.value).toBeNull();
  });

  it('rejects empty body and oversized body (> SKILL_BODY_MAX_BYTES) — invalid_body', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const empty = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: '' },
      { db: db as never },
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('invalid_body');

    const oversized = await createUserSkill(
      {
        userId,
        name: 'A',
        slug: 'a',
        body: 'x'.repeat(SKILL_BODY_MAX_BYTES + 1),
      },
      { db: db as never },
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe('invalid_body');
  });

  it('description bound: 500 chars accepted, 501 rejected as invalid_description (create + summary)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const atLimit = 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS);
    const ok = await createUserSkill(
      {
        userId,
        name: 'A',
        slug: 'a',
        body: 'x',
        description: atLimit,
      },
      { db: db as never },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected ok');

    const over = await createUserSkill(
      {
        userId,
        name: 'B',
        slug: 'b',
        body: 'x',
        description: 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 1),
      },
      { db: db as never },
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('invalid_description');

    // No row persisted for the rejected create.
    const listed = await listUserSkills(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(1);

    // updateUserSkillSummary also rejects an oversize description.
    const id = ok.value.id;
    const badSummary = await updateUserSkillSummary(
      userId,
      id,
      { name: 'A', description: 'y'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 1) },
      { db: db as never },
    );
    expect(badSummary.ok).toBe(false);
    if (!badSummary.ok) expect(badSummary.code).toBe('invalid_description');

    // The stored description is unchanged (still 500 chars, not wiped).
    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.description).toBe(atLimit);
  });

  it('list is user-scoped: another user sees an empty list', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'x' },
      { db: db as never },
    );

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const otherList = await listUserSkills(otherId, { db: db as never });
    expect(otherList.ok).toBe(true);
    if (!otherList.ok) throw new Error('expected ok');
    expect(otherList.value).toEqual([]);
  });

  it('listUserSkillsBySlugs is candidate-scoped (slug IN), user-scoped, empty IN skips', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'x', description: 'alpha' },
      { db: db as never },
    );
    await createUserSkill(
      { userId, name: 'B', slug: 'b', body: 'x', description: 'bravo' },
      { db: db as never },
    );
    await createUserSkill(
      { userId, name: 'C', slug: 'c', body: 'x', description: 'charlie' },
      { db: db as never },
    );

    const subset = await listUserSkillsBySlugs(userId, ['c', 'a', 'a', 'Not-A-Slug'], {
      db: db as never,
    });
    expect(subset.ok).toBe(true);
    if (!subset.ok) throw new Error('expected ok');
    expect(subset.value.map((s) => s.slug).sort()).toEqual(['a', 'c']);
    expect(subset.value.every((s) => !('body' in s))).toBe(true);

    const empty = await listUserSkillsBySlugs(userId, [], { db: db as never });
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error('expected ok');
    expect(empty.value).toEqual([]);

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const cross = await listUserSkillsBySlugs(otherId, ['a', 'b'], {
      db: db as never,
    });
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error('expected ok');
    expect(cross.value).toEqual([]);
  });

  it('listUserSkillsBySlugs slices IN to sticky+always-on+1 (keeps first N)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    await createUserSkill(
      { userId, name: 'First', slug: 's0', body: 'x' },
      { db: db as never },
    );
    const inCapSlug = `s${HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX}`;
    const droppedSlug = `s${HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX + 1}`;
    await createUserSkill(
      { userId, name: 'InCap', slug: inCapSlug, body: 'x' },
      { db: db as never },
    );
    await createUserSkill(
      { userId, name: 'Dropped', slug: droppedSlug, body: 'x' },
      { db: db as never },
    );
    const slugs = Array.from(
      { length: HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX + 2 },
      (_, i) => `s${i}`,
    );
    const listed = await listUserSkillsBySlugs(userId, slugs, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.map((s) => s.slug).sort()).toEqual(['s0', inCapSlug].sort());
    expect(listed.value.map((s) => s.slug)).not.toContain(droppedSlug);
  });

  it('empty user → empty list; missing userId create → no_membership', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const listed = await listUserSkills(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toEqual([]);

    const noUser = await listUserSkills('', { db: db as never });
    expect(noUser.ok).toBe(true);
    if (!noUser.ok) throw new Error('expected ok');
    expect(noUser.value).toEqual([]);

    const createNoUser = await createUserSkill(
      { userId: '', name: 'A', slug: 'a', body: 'x' },
      { db: db as never },
    );
    expect(createNoUser.ok).toBe(false);
    if (!createNoUser.ok) expect(createNoUser.code).toBe('no_membership');
  });
});

describe('setAlwaysOn + listAlwaysOnSkills (plan #720 phase 2)', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  it('toggles is_always_on on a skill; listAlwaysOnSkills returns only enabled slugs', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const a = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'body a' },
      { db: db as never },
    );
    const b = await createUserSkill(
      { userId, name: 'B', slug: 'b', body: 'body b' },
      { db: db as never },
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // None set as always-on initially.
    const before = await listAlwaysOnSkills(userId, { db: db as never });
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error('expected ok');
    expect(before.value).toEqual([]);

    // Set skill A to always-on.
    const aId = a.ok ? a.value.id : '';
    const set = await setAlwaysOn(userId, aId, true, { db: db as never });
    expect(set.ok).toBe(true);

    const after = await listAlwaysOnSkills(userId, { db: db as never });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('expected ok');
    expect(after.value).toEqual(['a']);

    // Set skill B to always-on too.
    const bId = b.ok ? b.value.id : '';
    const set2 = await setAlwaysOn(userId, bId, true, { db: db as never });
    expect(set2.ok).toBe(true);

    const after2 = await listAlwaysOnSkills(userId, { db: db as never });
    expect(after2.ok).toBe(true);
    if (!after2.ok) throw new Error('expected ok');
    expect(after2.value).toContain('a');
    expect(after2.value).toContain('b');

    // Toggle skill A off.
    const off = await setAlwaysOn(userId, aId, false, { db: db as never });
    expect(off.ok).toBe(true);

    const after3 = await listAlwaysOnSkills(userId, { db: db as never });
    expect(after3.ok).toBe(true);
    if (!after3.ok) throw new Error('expected ok');
    expect(after3.value).toEqual(['b']);
  });

  it('enforces USER_ALWAYS_ON_SKILLS_MAX when setting true; setting false always ok', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const ids: string[] = [];

    // Create (CAP + 1) skills but only set CAP as always-on.
    for (let i = 0; i < USER_ALWAYS_ON_SKILLS_MAX + 1; i++) {
      const c = await createUserSkill(
        { userId, name: `S${i}`, slug: `s_${i}`, body: `body ${i}` },
        { db: db as never },
      );
      expect(c.ok).toBe(true);
      if (c.ok) ids.push(c.value.id);
    }

    // Set the first CAP to always-on — all must succeed.
    for (let i = 0; i < USER_ALWAYS_ON_SKILLS_MAX; i++) {
      const s = await setAlwaysOn(userId, ids[i], true, { db: db as never });
      expect(s.ok).toBe(true);
    }

    // One more over the cap must fail.
    const over = await setAlwaysOn(userId, ids[USER_ALWAYS_ON_SKILLS_MAX], true, { db: db as never });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain('always-on limit reached');

    // Setting false on an existing always-on skill is always ok.
    const off = await setAlwaysOn(userId, ids[0], false, { db: db as never });
    expect(off.ok).toBe(true);

    // Now we have one slot; setting true after freeing a slot works.
    const refill = await setAlwaysOn(userId, ids[USER_ALWAYS_ON_SKILLS_MAX], true, { db: db as never });
    expect(refill.ok).toBe(true);
  });

  it('listAlwaysOnSkills caps on read at USER_ALWAYS_ON_SKILLS_MAX (race-safe)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    for (let i = 0; i < USER_ALWAYS_ON_SKILLS_MAX + 1; i++) {
      const c = await createUserSkill(
        { userId, name: `S${i}`, slug: `s_${i}`, body: `body ${i}` },
        { db: db as never },
      );
      expect(c.ok).toBe(true);
    }
    // Bypass setAlwaysOn write cap (simulates a concurrent race past the cap).
    await db
      .update(schema.userSkills)
      .set({ isAlwaysOn: true })
      .where(eq(schema.userSkills.userId, userId));
    const listed = await listAlwaysOnSkills(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(USER_ALWAYS_ON_SKILLS_MAX);
  });

  it('setAlwaysOn returns not_found for a foreign/non-existent skill', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const other = await seedUser('t2', 'other@example.com');
    const a = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'body' },
      { db: db as never },
    );
    expect(a.ok).toBe(true);

    // Foreign user id → not_found
    const foreign = await setAlwaysOn(
      other.userId,
      a.ok ? a.value.id : '',
      true,
      { db: db as never },
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe('not_found');

    // Bogus id → not_found
    const bogus = await setAlwaysOn(
      userId,
      '00000000-0000-0000-0000-000000000000',
      true,
      { db: db as never },
    );
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.code).toBe('not_found');
  });
});

describe('skill version history (plan #711 phase 1)', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  async function countVersions(skillId: string): Promise<number> {
    const rows = await db
      .select({ count: schema.userSkillVersions.id })
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, skillId));
    return rows.length;
  }

  it('create inserts one initial version row recording the create body', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'initial-body' },
      { db: db as never },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected ok');

    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, created.value.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('initial-body');
  });

  it('updateUserSkillBody changes the body AND inserts a version row for the new body', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');

    const updated = await updateUserSkillBody(userId, id, 'v2', { db: db as never });
    expect(updated.ok).toBe(true);

    // Live body changed.
    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.body).toBe('v2');

    // Two version rows: create's v1 + update's v2.
    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    expect(rows).toHaveLength(2);
    const bodies = rows.map((r) => r.body);
    expect(bodies).toContain('v1');
    expect(bodies).toContain('v2');
  });

  it('listSkillVersions lists newest-first summaries (no body) for the owner; foreign skill → empty (no leak)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await updateUserSkillBody(userId, id, 'v2', { db: db as never });

    const listed = await listSkillVersions(userId, id, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(2);
    // Newest first → v2's row is index 0.
    const first = listed.value[0]!;
    const firstRow = (
      await db
        .select()
        .from(schema.userSkillVersions)
        .where(eq(schema.userSkillVersions.id, first.id))
    )[0];
    expect(firstRow.body).toBe('v2');
    // Summary projection: no body.
    expect('body' in (listed.value[0] as unknown as { body?: unknown })).toBe(false);

    // Foreign user's id → their own empty list (no existence leak).
    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const foreign = await listSkillVersions(otherId, id, { db: db as never });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error('expected ok');
    expect(foreign.value).toEqual([]);
  });

  it('getSkillVersion returns a single version body to the owner; foreign id → null (no leak)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await updateUserSkillBody(userId, id, 'v2', { db: db as never });

    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    const versionRow = rows.find((r) => r.body === 'v1');
    if (!versionRow) throw new Error('expected v1 version row');

    const got = await getSkillVersion(userId, id, versionRow.id, { db: db as never });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value?.body).toBe('v1');

    const { userId: otherId } = await seedUser('t2', 'other@example.com');
    const foreign = await getSkillVersion(otherId, id, versionRow.id, {
      db: db as never,
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error('expected ok');
    expect(foreign.value).toBeNull();
  });

  it('rollbackSkill copies the version body into live body AND inserts a NEW version row', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await updateUserSkillBody(userId, id, 'v2', { db: db as never });
    await updateUserSkillBody(userId, id, 'v3', { db: db as never });

    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    const v1Row = rows.find((r) => r.body === 'v1');
    if (!v1Row) throw new Error('expected v1 version row');

    const rolled = await rollbackSkill(userId, id, v1Row.id, { db: db as never });
    expect(rolled.ok).toBe(true);

    // Live body is now v1.
    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.body).toBe('v1');

    // Rollback INSERTED a new row (v1 again), so the timeline grew to 4.
    expect(await countVersions(id)).toBe(4);
  });

  it('at the cap, updateUserSkillBody rejects AND leaves the live body unchanged', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');

    // Seed to exactly SKILL_VERSION_MAX rows (create added 1, add 99 more).
    for (let i = 0; i < SKILL_VERSION_MAX - 1; i++) {
      await db.insert(schema.userSkillVersions).values({
        skillId: id,
        body: `seed-${i}`,
        label: '',
      });
    }
    expect(await countVersions(id)).toBe(SKILL_VERSION_MAX);

    // At the cap an edit must be rejected WITHOUT mutating the live body.
    const rejected = await updateUserSkillBody(userId, id, 'should-not-stick', {
      db: db as never,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('invalid_body');

    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    // Body is still the original — the cap reject never committed a write.
    expect(bySlug.value?.body).toBe('v1');

    // No version row was added for the rejected edit.
    expect(await countVersions(id)).toBe(SKILL_VERSION_MAX);
  });

  it('at the cap, rollbackSkill rejects AND leaves the live body unchanged', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await updateUserSkillBody(userId, id, 'v2', { db: db as never });

    // Find the v1 version row to attempt a rollback to.
    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    const v1Row = rows.find((r) => r.body === 'v1');
    if (!v1Row) throw new Error('expected v1 version row');

    // Seed to exactly SKILL_VERSION_MAX rows (create added 1, update added 1).
    for (let i = 0; i < SKILL_VERSION_MAX - 2; i++) {
      await db.insert(schema.userSkillVersions).values({
        skillId: id,
        body: `seed-${i}`,
        label: '',
      });
    }
    expect(await countVersions(id)).toBe(SKILL_VERSION_MAX);

    // At the cap, rollback (which would INSERT a row) must be rejected WITHOUT
    // mutating the live body (adversarial-review L6 round 2: untested branch).
    const rejected = await rollbackSkill(userId, id, v1Row.id, { db: db as never });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('invalid_body');

    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    // Body is still v2 — the cap reject never committed a write.
    expect(bySlug.value?.body).toBe('v2');

    // No version row was added for the rejected rollback.
    expect(await countVersions(id)).toBe(SKILL_VERSION_MAX);
  });

  it('first edit of a legacy pre-0012 skill (count === 0) snapshots the ORIGINAL body so Restore can reach it', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'legacy' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    // Simulate a pre-0012 skill (schema-only cutover, no backfill): the skill
    // exists but has NO version history yet (adversarial-review L1 round 2).
    await db
      .delete(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    expect(await countVersions(id)).toBe(0);

    const updated = await updateUserSkillBody(userId, id, 'edited', {
      db: db as never,
    });
    expect(updated.ok).toBe(true);

    // Two rows now: the ORIGINAL pre-edit body + the new edited body. The
    // original was snapshotted BEFORE the update so the timeline exposes a
    // Restore target for the previous playbook (not just the new text).
    const rows = await db
      .select()
      .from(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    expect(rows).toHaveLength(2);
    const bodies = rows.map((r) => r.body);
    expect(bodies).toContain('legacy');
    expect(bodies).toContain('edited');

    // Restore to the snapshotted original works.
    const origRow = rows.find((r) => r.body === 'legacy');
    if (!origRow) throw new Error('expected original snapshot row');
    const rolled = await rollbackSkill(userId, id, origRow.id, { db: db as never });
    expect(rolled.ok).toBe(true);
    const bySlug = await getSkillBySlug(userId, 'a', { db: db as never });
    expect(bySlug.ok).toBe(true);
    if (!bySlug.ok) throw new Error('expected ok');
    expect(bySlug.value?.body).toBe('legacy');
  });

  it('two-insert first edit (snapshot + new body, ONE tx) orders EDITED newest-first — no created_at tie (adversarial-review L1 round 3)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'legacy' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    // Legacy pre-0012 skill with no version history yet.
    await db
      .delete(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    expect(await countVersions(id)).toBe(0);

    const updated = await updateUserSkillBody(userId, id, 'edited', {
      db: db as never,
    });
    expect(updated.ok).toBe(true);

    const listed = await listSkillVersions(userId, id, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(2);

    // Resolve each listed summary to its stored body.
    const bodiesForListed: (string | undefined)[] = [];
    for (const s of listed.value) {
      const row = (
        await db
          .select()
          .from(schema.userSkillVersions)
          .where(eq(schema.userSkillVersions.id, s.id))
      )[0];
      bodiesForListed.push(row?.body);
    }
    // Index 0 is the **now** row → must be the freshly-edited (live) body, NOT
    // the snapshot, even though both rows were written in ONE transaction whose
    // shared Postgres `now()` would otherwise give them the SAME created_at.
    expect(bodiesForListed[0]).toBe('edited');
    expect(bodiesForListed[1]).toBe('legacy');
    // The snapshot's created_at is skewed strictly before the new-body row.
    expect(new Date(listed.value[0]!.createdAt).getTime()).toBeGreaterThan(
      new Date(listed.value[1]!.createdAt).getTime(),
    );
  });

  it('a SECOND edit after a legacy first-edit does NOT insert a duplicate snapshot (no extra cap-slot burn)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'legacy' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await db
      .delete(schema.userSkillVersions)
      .where(eq(schema.userSkillVersions.skillId, id));
    expect(await countVersions(id)).toBe(0);

    // First edit writes snapshot + new body (2 rows).
    await updateUserSkillBody(userId, id, 'edited1', { db: db as never });
    expect(await countVersions(id)).toBe(2);

    // Second edit: the pre-edit body (edited1) is ALREADY stored as a version,
    // so the order-INDEPENDENT capture check (`WHERE body = prevBody`) must
    // NOT snapshot it again — only the new body row is added, growing the count
    // by exactly 1 (never a duplicate snapshot that silently burns a cap slot).
    await updateUserSkillBody(userId, id, 'edited2', { db: db as never });
    expect(await countVersions(id)).toBe(3);

    // Newest-first is still deterministic: the latest edit is the **now** row.
    const listed = await listSkillVersions(userId, id, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toHaveLength(3);
    const firstRow = (
      await db
        .select()
        .from(schema.userSkillVersions)
        .where(eq(schema.userSkillVersions.id, listed.value[0]!.id))
    )[0];
    expect(firstRow.body).toBe('edited2');
  });

  it('deleting a skill cascade-deletes its version history (FK ON DELETE CASCADE)', async () => {
    const { userId } = await seedUser('t1', 'u@example.com');
    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'v1' },
      { db: db as never },
    );
    const id = created.ok ? created.value.id : '';
    if (!created.ok) throw new Error('expected ok');
    await updateUserSkillBody(userId, id, 'v2', { db: db as never });
    expect(await countVersions(id)).toBe(2);

    const del = await deleteUserSkill(userId, id, { db: db as never });
    expect(del.ok).toBe(true);

    expect(await countVersions(id)).toBe(0);
  });
});

/**
 * Missing-table behavior is exercised on an ISOLATED engine (the documented
 * carve-out in lib/tenancy/test/shared.ts): we boot a fresh engine, apply all
 * migrations, then DROP only `user_skills` to simulate deploy-before-migrate.
 * The store must fail closed with `unavailable` (never throw / never leak).
 */
describe('userSkills unavailable (missing table)', () => {
  let iso: Awaited<ReturnType<typeof createIsolatedTestDb>>;

  beforeAll(async () => {
    iso = await createIsolatedTestDb();
  });

  afterAll(async () => {
    await iso.close();
  });

  async function seedUserId(): Promise<string> {
    const [tenant] = await iso.db
      .insert(schema.tenants)
      .values({ slug: 'iso-t', name: 'iso-t' })
      .returning({ id: schema.tenants.id });
    const [user] = await iso.db
      .insert(schema.users)
      .values({ email: 'iso@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    await iso.db.insert(schema.tenantMembers).values({
      tenantId: tenant.id,
      userId: user.id,
      role: 'owner',
    });
    return user.id;
  }

  it('missing user_skills table → unavailable (create + list + getBySlug fail closed)', async () => {
    // Drop the table after seeding so membership resolution still succeeds but
    // any user_skills query hits the undefined relation.
    await iso.client.exec('DROP TABLE IF EXISTS "user_skill_versions"');
    await iso.client.exec('DROP TABLE IF EXISTS "user_skills"');
    const userId = await seedUserId();

    const created = await createUserSkill(
      { userId, name: 'A', slug: 'a', body: 'x' },
      { db: iso.db as never },
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe('unavailable');

    const listed = await listUserSkills(userId, { db: iso.db as never });
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.code).toBe('unavailable');

    const bySlug = await getSkillBySlug(userId, 'a', { db: iso.db as never });
    expect(bySlug.ok).toBe(false);
    if (!bySlug.ok) expect(bySlug.code).toBe('unavailable');

    const byId = await getSkillById(
      userId,
      '00000000-0000-0000-0000-000000000000',
      { db: iso.db as never },
    );
    expect(byId.ok).toBe(false);
    if (!byId.ok) expect(byId.code).toBe('unavailable');
  });
});
