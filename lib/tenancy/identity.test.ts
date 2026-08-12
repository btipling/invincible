import { createTenancyTestDb } from './test/pglite';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { FIXTURE_PASSWORD_HASH } from './test/fixtures';
import {
  assertNotBreakGlass,
  ensureDefaultTenantMembership,
  findOrCreateOidcUser,
  IdentityError,
  isBreakGlassUser,
  normalizeIdpSubject,
  scimCreateUser,
  scimSuspendUser,
  scimUpdateUser,
  listScimUsers,
  listUsersForAdmin,
  getScimUserById,
} from './identity';

describe('normalizeIdpSubject', () => {
  it('joins trimmed issuer and sub', () => {
    expect(normalizeIdpSubject(' https://idp.example ', ' abc ')).toBe(
      'https://idp.example|abc',
    );
  });

  it('rejects empty issuer or sub', () => {
    expect(() => normalizeIdpSubject('', 'x')).toThrow(IdentityError);
    expect(() => normalizeIdpSubject('iss', '  ')).toThrow(IdentityError);
  });
});

describe('identity helpers (pglite)', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let tenantId: string;

  beforeAll(async () => {
    ({ client, db } = await createTenancyTestDb());

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'default', name: 'Default', settings: {} })
      .returning();
    tenantId = tenant.id;

    const [owner] = await db
      .insert(schema.users)
      .values({
        email: 'owner@example.com',
        name: 'Owner',
        status: 'active',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'credentials',
      })
      .returning();
    ownerId = owner.id;

    await db.insert(schema.tenantMembers).values({
      tenantId,
      userId: ownerId,
      role: 'owner',
    });
  });


  it('ensureDefaultTenantMembership is idempotent and refuses owner', async () => {
    const [u] = await db
      .insert(schema.users)
      .values({
        email: 'member1@example.com',
        status: 'active',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'manual',
      })
      .returning();

    const first = await ensureDefaultTenantMembership(u.id, 'member', {
      db: db as never,
    });
    expect(first.created).toBe(true);
    expect(first.role).toBe('member');
    expect(first.tenantId).toBe(tenantId);

    const second = await ensureDefaultTenantMembership(u.id, 'member', {
      db: db as never,
    });
    expect(second.created).toBe(false);

    await expect(
      ensureDefaultTenantMembership(u.id, 'owner', { db: db as never }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('isBreakGlassUser true for credentials owner; false for scim member', async () => {
    expect(await isBreakGlassUser(ownerId, { db: db as never })).toBe(true);

    const scim = await scimCreateUser(
      {
        email: 'scim-bg@example.com',
        externalId: 'ext-bg',
        displayName: 'SCIM',
      },
      { db: db as never },
    );
    expect(await isBreakGlassUser(scim.id, { db: db as never })).toBe(false);
    await expect(
      assertNotBreakGlass(ownerId, { db: db as never }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('findOrCreateOidcUser creates, reuses, and refuses suspended', async () => {
    const subject = normalizeIdpSubject('https://idp.example', 'user-1');
    const first = await findOrCreateOidcUser(
      {
        subject,
        email: 'oidc1@example.com',
        name: 'Oidc One',
        emailVerified: true,
      },
      { db: db as never },
    );
    expect(first.created).toBe(true);
    expect(first.user.provisionSource).toBe('oidc');
    expect(first.user.idpSubject).toBe(subject);

    const second = await findOrCreateOidcUser(
      { subject, email: 'oidc1@example.com', emailVerified: true },
      { db: db as never },
    );
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);

    await db
      .update(schema.users)
      .set({ status: 'suspended' })
      .where(eq(schema.users.id, first.user.id));

    await expect(
      findOrCreateOidcUser(
        { subject, email: 'oidc1@example.com', emailVerified: true },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'suspended' });
  });

  it('findOrCreateOidcUser links null idp_subject by email; conflicts on different subject', async () => {
    const [cred] = await db
      .insert(schema.users)
      .values({
        email: 'linkme@example.com',
        name: 'Link Me',
        status: 'active',
        passwordHash: FIXTURE_PASSWORD_HASH,
        provisionSource: 'credentials',
      })
      .returning();

    const subject = normalizeIdpSubject('https://idp.example', 'link-user');
    const linked = await findOrCreateOidcUser(
      {
        subject,
        email: 'linkme@example.com',
        name: 'Linked Name',
        emailVerified: true,
      },
      { db: db as never },
    );
    expect(linked.created).toBe(false);
    expect(linked.user.id).toBe(cred.id);
    expect(linked.user.idpSubject).toBe(subject);
    expect(linked.user.name).toBe('Linked Name');

    const other = normalizeIdpSubject('https://idp.example', 'other-sub');
    await expect(
      findOrCreateOidcUser(
        { subject: other, email: 'linkme@example.com', emailVerified: true },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('findOrCreateOidcUser JIT-creates when email is new even if emailVerified false', async () => {
    const subject = normalizeIdpSubject('https://idp.example', 'jit-unverified');
    const created = await findOrCreateOidcUser(
      {
        subject,
        email: 'jit-new@example.com',
        name: 'JIT New',
        emailVerified: false,
      },
      { db: db as never },
    );
    expect(created.created).toBe(true);
    expect(created.user.email).toBe('jit-new@example.com');
    expect(created.user.idpSubject).toBe(subject);
    expect(created.user.provisionSource).toBe('oidc');
  });

  it('findOrCreateOidcUser refuses email-link without emailVerified', async () => {
    await db.insert(schema.users).values({
      email: 'unverified-link@example.com',
      status: 'active',
      passwordHash: FIXTURE_PASSWORD_HASH,
      provisionSource: 'credentials',
    });

    const subject = normalizeIdpSubject('https://idp.example', 'unverified-1');
    await expect(
      findOrCreateOidcUser(
        {
          subject,
          email: 'unverified-link@example.com',
          emailVerified: false,
        },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('findOrCreateOidcUser SCIM email-link keeps provision_source=scim', async () => {
    const scim = await scimCreateUser(
      {
        email: 'scim-oidc@example.com',
        externalId: 'ext-oidc-link',
        displayName: 'SCIM OIDC',
      },
      { db: db as never },
    );
    expect(scim.provisionSource).toBe('scim');
    expect(scim.idpSubject).toBeNull();

    const subject = normalizeIdpSubject('https://idp.example', 'scim-person');
    const linked = await findOrCreateOidcUser(
      {
        subject,
        email: 'scim-oidc@example.com',
        name: 'SCIM via OIDC',
        emailVerified: true,
      },
      { db: db as never },
    );
    expect(linked.created).toBe(false);
    expect(linked.user.id).toBe(scim.id);
    expect(linked.user.idpSubject).toBe(subject);
    expect(linked.user.provisionSource).toBe('scim');
  });

  it('scimCreateUser / scimSuspendUser / cannot suspend break-glass', async () => {
    const created = await scimCreateUser(
      {
        email: 'scim2@example.com',
        externalId: 'ext-2',
        displayName: 'Scim Two',
        active: true,
      },
      { db: db as never },
    );
    expect(created.provisionSource).toBe('scim');
    expect(created.scimExternalId).toBe('ext-2');
    expect(created.status).toBe('active');

    const updated = await scimUpdateUser(
      created.id,
      { displayName: 'Scim Two Updated', active: true },
      { db: db as never },
    );
    expect(updated.name).toBe('Scim Two Updated');

    const suspended = await scimSuspendUser(created.id, { db: db as never });
    expect(suspended.status).toBe('suspended');

    // row still exists
    const [still] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, created.id));
    expect(still).toBeTruthy();

    await expect(
      scimSuspendUser(ownerId, { db: db as never }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      scimCreateUser(
        { email: 'scim2@example.com', externalId: 'ext-other' },
        { db: db as never },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('listScimUsers only SCIM-managed; listUsersForAdmin shows all', async () => {
    await db.insert(schema.users).values({
      email: 'cred@example.com',
      status: 'active',
      passwordHash: FIXTURE_PASSWORD_HASH,
      provisionSource: 'credentials',
    });
    const scim = await scimCreateUser(
      { email: 'listed-scim@example.com', externalId: 'list-ext' },
      { db: db as never },
    );
    const listed = await listScimUsers({}, { db: db as never });
    expect(listed.users.some((u) => u.id === scim.id)).toBe(true);
    expect(listed.users.every((u) => u.provisionSource === 'scim' || u.scimExternalId)).toBe(
      true,
    );
    expect(listed.users.some((u) => u.email === 'cred@example.com')).toBe(false);

    const filtered = await listScimUsers(
      { filter: { kind: 'userName', value: 'listed-scim@example.com' } },
      { db: db as never },
    );
    expect(filtered.totalResults).toBe(1);
    expect(filtered.users[0]?.id).toBe(scim.id);

    const admin = await listUsersForAdmin({ db: db as never });
    expect(admin.some((u) => u.email === 'cred@example.com')).toBe(true);
    expect(admin.some((u) => u.email === 'listed-scim@example.com')).toBe(true);

    expect(await getScimUserById(scim.id, { db: db as never })).not.toBeNull();
    const cred = admin.find((u) => u.email === 'cred@example.com')!;
    expect(await getScimUserById(cred.id, { db: db as never })).toBeNull();
  });

});
