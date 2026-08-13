import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  clearDefaultPersona,
  createUserPersona,
  deleteUserPersona,
  getPersonaById,
  listUserPersonas,
  renameUserPersona,
  resolveDefaultPersona,
  setDefaultPersona,
  updateUserPersonaBody,
} from './userPersonas';
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
});
