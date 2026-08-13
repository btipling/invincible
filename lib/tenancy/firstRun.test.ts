import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { verifyPassword } from './password';
import {
  createFirstTenant,
  FirstRunError,
  hasAnyTenant,
  slugifyTenantName,
} from './firstRun';
import { getSharedDb, resetTenantTables } from './test/shared';

let db!: ReturnType<typeof drizzle<typeof schema>>;

describe('firstRun', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();
  });

  it('hasAnyTenant: false on empty DB, true once a tenant exists', async () => {
    expect(await hasAnyTenant({ db: db as never })).toBe(false);
    await db.insert(schema.tenants).values({ slug: 'a', name: 'A' });
    expect(await hasAnyTenant({ db: db as never })).toBe(true);
  });

  it('slugifyTenantName derives a short human slug (no fixed "default")', () => {
    expect(slugifyTenantName('Acme Corp')).toBe('acme-corp');
    expect(slugifyTenantName('  Cáfe 研究 Dev ')).toBe(
      'cafe-dev',
    );
    expect(slugifyTenantName('A--B _ C')).toBe('a-b-c');
    expect(slugifyTenantName('!!!')).toBe('');
  });

  it('createFirstTenant happy path: tenant + owner + owner membership, NO sandbox, NO DEK', async () => {
    const res = await createFirstTenant(
      { tenantName: 'Acme Corp', email: 'admin@example.com', password: 's3cure-pw!' },
      { db: db as never },
    );

    expect(res.slug).toBe('acme-corp');
    expect(res.tenantId).toBeTruthy();
    expect(res.userId).toBeTruthy();

    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, res.tenantId));
    expect(tenant).toBeTruthy();
    expect(tenant.slug).toBe('acme-corp');
    expect(tenant.name).toBe('Acme Corp');
    // DEK is lazy — never provisioned at sign-up.
    expect(tenant.dekCiphertext).toBeNull();

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, res.userId));
    expect(user.email).toBe('admin@example.com');
    expect(user.status).toBe('active');
    expect(user.provisionSource).toBe('credentials');
    expect(user.passwordHash).toBeTruthy();
    expect(await verifyPassword('s3cure-pw!', user.passwordHash!)).toBe(true);

    const memberships = await db
      .select()
      .from(schema.tenantMembers)
      .where(eq(schema.tenantMembers.userId, res.userId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
    expect(memberships[0].tenantId).toBe(res.tenantId);

    // No sandbox is created at sign-up.
    const sandboxes = await db.select().from(schema.sandboxes);
    expect(sandboxes).toHaveLength(0);
  });

  it('second create fails closed (already_initialized); exactly one tenant', async () => {
    await createFirstTenant(
      { tenantName: 'Alpha', email: 'a@example.com', password: 'password-1' },
      { db: db as never },
    );
    await expect(
      createFirstTenant(
        { tenantName: 'Beta', email: 'b@example.com', password: 'password-2' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'already_initialized' });

    const tenants = await db.select().from(schema.tenants);
    expect(tenants).toHaveLength(1);
  });

  it('validates inputs (no partial state, invalid_input code)', async () => {
    await expect(
      createFirstTenant(
        { tenantName: '', email: 'a@example.com', password: 'password-1' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      createFirstTenant(
        { tenantName: '!!!', email: 'a@example.com', password: 'password-1' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(
      createFirstTenant(
        { tenantName: 'Acme', email: 'not-an-email', password: 'password-1' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // Short password
    await expect(
      createFirstTenant(
        { tenantName: 'Acme', email: 'a@example.com', password: 'short' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // Whitespace in password
    await expect(
      createFirstTenant(
        { tenantName: 'Acme', email: 'a@example.com', password: 'has space 99' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // Nothing was partially created by any failing attempt.
    expect((await db.select().from(schema.tenants))).toHaveLength(0);
    expect((await db.select().from(schema.users))).toHaveLength(0);
  });

  it('is atomic: a failure mid-tx leaves no partial tenant row', async () => {
    // Pre-existing user with the target email forces a unique violation on the
    // owner insert inside the tx; the tenant insert must roll back with it.
    await db.insert(schema.users).values({
      email: 'taken@example.com',
      status: 'active',
    });

    await expect(
      createFirstTenant(
        { tenantName: 'Atomic', email: 'taken@example.com', password: 'password-1' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const tenants = await db.select().from(schema.tenants);
    expect(tenants).toHaveLength(0);
  });

  it('FirstRunError carries a stable message', async () => {
    const err = new FirstRunError('boom', 'invalid_input');
    expect(err).toBeInstanceOf(FirstRunError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('invalid_input');
    expect(err.message).toBe('boom');
  });
});
