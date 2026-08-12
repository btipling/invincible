import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  listUserSandboxChoices,
  setUserPreferredSandbox,
} from './userPreferredSandbox';

describe('userPreferredSandbox', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
  let tenantId: string;
  let sbA: string;
  let sbB: string;

  beforeAll(async () => {

    ({ client, db } = await createTenancyTestDb());
  });


  beforeEach(async () => {
    await db.delete(schema.userPreferredSandbox);
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 't1', name: 'T1' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'u@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    userId = user.id;

    await db.insert(schema.tenantMembers).values({
      tenantId,
      userId,
      role: 'owner',
    });

    const [a] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Alpha',
        slug: 'alpha',
        backend: 'vercel',
        image: 'bjorns-projects/invincible/invincible-dev:latest',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sbA = a.id;

    const [b] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Bravo',
        slug: 'bravo',
        backend: 'byo',
        baseUrl: 'http://127.0.0.1:8787',
        tokenCiphertext: 'ct',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sbB = b.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId: sbA,
      userId,
      canRead: true,
      canWrite: true,
    });
  });

  it('lists grants and admin-visible ungranted sandboxes', async () => {
    const listed = await listUserSandboxChoices(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.options).toHaveLength(2);
    const alpha = listed.value.options.find((o) => o.slug === 'alpha');
    const bravo = listed.value.options.find((o) => o.slug === 'bravo');
    expect(alpha?.usable).toBe(true);
    expect(alpha?.granted).toBe(true);
    expect(bravo?.granted).toBe(false);
    expect(bravo?.usable).toBe(false);
  });

  it('set preferred grants admin and saves preference', async () => {
    const set = await setUserPreferredSandbox(userId, sbB, { db: db as never });
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error('expected ok');
    expect(set.value.preferredSandboxId).toBe(sbB);

    const grants = await db
      .select()
      .from(schema.sandboxGrants)
      .where(eq(schema.sandboxGrants.sandboxId, sbB));
    expect(grants).toHaveLength(1);
    expect(grants[0].canWrite).toBe(true);

    const listed = await listUserSandboxChoices(userId, { db: db as never });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value.preferredSandboxId).toBe(sbB);
  });
});
