import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  createUserSkill,
  deleteUserSkill,
  getSkillById,
  getSkillBySlug,
  listUserSkills,
  renameUserSkill,
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  updateUserSkillBody,
  updateUserSkillSummary,
} from './userSkills';
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
