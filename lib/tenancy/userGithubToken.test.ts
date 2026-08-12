import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  clearUserGithubToken,
  decryptUserGithubTokenForServer,
  getUserGithubTokenStatus,
  setUserGithubToken,
  USER_GITHUB_TOKEN_MAX_LEN,
} from './userGithubToken';
import { getSharedDb, resetTenantTables } from './test/shared';

const AMK = Buffer.alloc(32, 11);

let db!: ReturnType<typeof drizzle<typeof schema>>;
let tenantId: string;
let userId: string;
let otherUserId: string;

describe('userGithubToken', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'acme', name: 'Acme' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    userId = user.id;

    const [other] = await db
      .insert(schema.users)
      .values({ email: 'other@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    otherUserId = other.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId, role: 'owner' },
      { tenantId, userId: otherUserId, role: 'member' },
    ]);
  });

  const deps = () => ({ db: db as never, amk: AMK });

  it('set → decrypt round-trip; status mask-only', async () => {
    const set = await setUserGithubToken(userId, '  ghp_test_token_aaaa  ', deps());
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error(set.error);

    const status = await getUserGithubTokenStatus(userId, deps());
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value.configured).toBe(true);
    expect(status.value.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(status.value)).not.toMatch(/ghp_test|ciphertext|v1:/i);

    const dec = await decryptUserGithubTokenForServer(userId, deps());
    expect(dec.ok).toBe(true);
    if (!dec.ok) throw new Error(dec.error);
    expect(dec.value).toBe('ghp_test_token_aaaa');

    const raw = await db
      .select()
      .from(schema.userGithubTokens)
      .where(eq(schema.userGithubTokens.userId, userId));
    expect(raw).toHaveLength(1);
    expect(raw[0].tenantId).toBe(tenantId);
    expect(raw[0].tokenCiphertext).toBeTruthy();
    expect(raw[0].tokenKekVersion).toBe(1);
  });

  it('clear nulls ciphertext and kek version', async () => {
    await setUserGithubToken(userId, 'ghp_clear_me', deps());
    const cleared = await clearUserGithubToken(userId, deps());
    expect(cleared.ok).toBe(true);

    const raw = await db
      .select()
      .from(schema.userGithubTokens)
      .where(eq(schema.userGithubTokens.userId, userId));
    expect(raw[0].tokenCiphertext).toBeNull();
    expect(raw[0].tokenKekVersion).toBeNull();

    const status = await getUserGithubTokenStatus(userId, deps());
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value.configured).toBe(false);

    const dec = await decryptUserGithubTokenForServer(userId, deps());
    expect(dec.ok).toBe(true);
    if (!dec.ok) throw new Error(dec.error);
    expect(dec.value).toBeNull();
  });

  it('rejects empty, control chars, oversize', async () => {
    const empty = await setUserGithubToken(userId, '   ', deps());
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('expected fail');
    expect(empty.code).toBe('invalid_token');

    const ctrl = await setUserGithubToken(userId, 'abc\nxyz', deps());
    expect(ctrl.ok).toBe(false);
    if (ctrl.ok) throw new Error('expected fail');
    expect(ctrl.code).toBe('invalid_token');

    const huge = await setUserGithubToken(
      userId,
      'a'.repeat(USER_GITHUB_TOKEN_MAX_LEN + 1),
      deps(),
    );
    expect(huge.ok).toBe(false);
    if (huge.ok) throw new Error('expected fail');
    expect(huge.code).toBe('invalid_token');
  });

  it('replace updates ciphertext; no membership fails', async () => {
    await setUserGithubToken(userId, 'ghp_first', deps());
    await setUserGithubToken(userId, 'ghp_second', deps());
    const dec = await decryptUserGithubTokenForServer(userId, deps());
    expect(dec.ok && dec.value).toBe('ghp_second');

    const orphan = await db
      .insert(schema.users)
      .values({ email: 'orphan@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    const res = await setUserGithubToken(orphan[0].id, 'ghp_x', deps());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected fail');
    expect(res.code).toBe('no_membership');
  });

  it('status unconfigured when no row', async () => {
    const status = await getUserGithubTokenStatus(userId, deps());
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value).toEqual({ configured: false, updatedAt: null });
  });

  it('status/decrypt treat tenant_id mismatch as unset', async () => {
    await setUserGithubToken(userId, 'ghp_old_tenant', deps());

    // Simulate membership move: another tenant becomes sole membership.
    const [newTenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'other', name: 'Other' })
      .returning({ id: schema.tenants.id });
    await db.delete(schema.tenantMembers).where(eq(schema.tenantMembers.userId, userId));
    await db.insert(schema.tenantMembers).values({
      tenantId: newTenant.id,
      userId,
      role: 'owner',
    });

    const status = await getUserGithubTokenStatus(userId, deps());
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value).toEqual({ configured: false, updatedAt: null });

    const dec = await decryptUserGithubTokenForServer(userId, deps());
    expect(dec.ok).toBe(true);
    if (!dec.ok) throw new Error(dec.error);
    expect(dec.value).toBeNull();
  });
});
