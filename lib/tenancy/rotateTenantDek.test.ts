import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import { rotateTenantDek } from './rotateTenantDek';
import {
  ensureTenantDek,
  loadTenantDek,
} from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
  ]) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
}

const AMK = Buffer.alloc(32, 5);

describe('rotateTenantDek', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let tenantId: string;
  let otherTenantId: string;
  let sandboxA1: string;
  let sandboxA2: string;
  let sandboxB: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'acme', name: 'Acme' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [other] = await db
      .insert(schema.tenants)
      .values({ slug: 'other', name: 'Other' })
      .returning({ id: schema.tenants.id });
    otherTenantId = other.id;

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [admin] = await db
      .insert(schema.users)
      .values({ email: 'admin@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    adminId = admin.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'member@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: adminId, role: 'admin' },
      { tenantId, userId: memberId, role: 'member' },
      { tenantId: otherTenantId, userId: ownerId, role: 'owner' },
    ]);

    const { dek } = await ensureTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const { dek: otherDek } = await ensureTenantDek(otherTenantId, {
      db: db as never,
      amk: AMK,
    });

    const [s1] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'A1',
        slug: 'a1',
        baseUrl: 'https://a1.example',
        tokenCiphertext: encryptSecret('token-a1', dek),
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxA1 = s1.id;

    const [s2] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'A2',
        slug: 'a2',
        baseUrl: 'https://a2.example',
        tokenCiphertext: encryptSecret('token-a2', dek),
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxA2 = s2.id;

    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId: otherTenantId,
        name: 'B',
        slug: 'b',
        baseUrl: 'https://b.example',
        tokenCiphertext: encryptSecret('token-b', otherDek),
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxB = sb.id;
  });

  it('owner rotates: re-encrypts N sandboxes; old DEK fails; versions bump', async () => {
    const before = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(before.version).toBe(1);

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: true, dekVersion: 2 });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(after.version).toBe(2);
    expect(after.dek.equals(before.dek)).toBe(false);

    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.tenantId, tenantId));
    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(decryptSecret(byId[sandboxA1].tokenCiphertext, after.dek)).toBe(
      'token-a1',
    );
    expect(decryptSecret(byId[sandboxA2].tokenCiphertext, after.dek)).toBe(
      'token-a2',
    );
    expect(byId[sandboxA1].tokenKekVersion).toBe(2);
    expect(byId[sandboxA2].tokenKekVersion).toBe(2);
    expect(() =>
      decryptSecret(byId[sandboxA1].tokenCiphertext, before.dek),
    ).toThrow();
  });

  it('admin cannot rotate DEK', async () => {
    const res = await rotateTenantDek(adminId, tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('member cannot rotate DEK', async () => {
    const res = await rotateTenantDek(memberId, tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('other tenant DEK and tokens untouched', async () => {
    const otherBefore = await loadTenantDek(otherTenantId, {
      db: db as never,
      amk: AMK,
    });
    const [sbBefore] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxB));

    await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });

    const otherAfter = await loadTenantDek(otherTenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(otherAfter.dek.equals(otherBefore.dek)).toBe(true);
    expect(otherAfter.version).toBe(otherBefore.version);

    const [sbAfter] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxB));
    expect(sbAfter.tokenCiphertext).toBe(sbBefore.tokenCiphertext);
    expect(sbAfter.tokenKekVersion).toBe(sbBefore.tokenKekVersion);
    expect(decryptSecret(sbAfter.tokenCiphertext, otherAfter.dek)).toBe(
      'token-b',
    );
  });

  it('empty sandboxes still bumps DEK version', async () => {
    await db
      .delete(schema.sandboxes)
      .where(eq(schema.sandboxes.tenantId, tenantId));

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: true, dekVersion: 2 });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(after.version).toBe(2);
  });

  it('corrupt token mid-loop aborts with no partial commit', async () => {
    await db
      .update(schema.sandboxes)
      .set({ tokenCiphertext: 'v1:not:valid:ciphertext' })
      .where(eq(schema.sandboxes.id, sandboxA2));

    const before = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const [a1Before] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA1));

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: false, reason: 'db' });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(after.dek.equals(before.dek)).toBe(true);
    expect(after.version).toBe(before.version);

    const [a1After] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA1));
    expect(a1After.tokenCiphertext).toBe(a1Before.tokenCiphertext);
    expect(decryptSecret(a1After.tokenCiphertext, before.dek)).toBe('token-a1');
  });

  it('dual-mode rotates leftover AMK ciphertext', async () => {
    await db
      .update(schema.sandboxes)
      .set({ tokenCiphertext: encryptSecret('legacy-amk-token', AMK) })
      .where(eq(schema.sandboxes.id, sandboxA1));

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dual',
    });
    expect(res).toEqual({ ok: true, dekVersion: 2 });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const [row] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA1));
    expect(decryptSecret(row.tokenCiphertext, after.dek)).toBe(
      'legacy-amk-token',
    );
    expect(() => decryptSecret(row.tokenCiphertext, AMK)).toThrow();
  });

  it('dek-only mode fails closed on leftover AMK ciphertext (no partial commit)', async () => {
    await db
      .update(schema.sandboxes)
      .set({ tokenCiphertext: encryptSecret('legacy-amk-token', AMK) })
      .where(eq(schema.sandboxes.id, sandboxA1));

    const before = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const [a2Before] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA2));

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: false, reason: 'db' });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(after.dek.equals(before.dek)).toBe(true);
    expect(after.version).toBe(before.version);

    const [a2After] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA2));
    expect(a2After.tokenCiphertext).toBe(a2Before.tokenCiphertext);
    expect(decryptSecret(a2After.tokenCiphertext, before.dek)).toBe('token-a2');
  });

  it('not_found when user has no membership on tenant', async () => {
    const [stranger] = await db
      .insert(schema.users)
      .values({ email: 'x@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    const res = await rotateTenantDek(stranger.id, tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});
