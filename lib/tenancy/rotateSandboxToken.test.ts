import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import { rotateSandboxToken } from './rotateSandboxToken';
import { ensureTenantDek, loadTenantDek } from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
    '0003_provider_secrets.sql',
    '0004_user_mcp_servers.sql',
    '0005_sandbox_backend.sql',
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

const AMK = Buffer.alloc(32, 3);

describe('rotateSandboxToken', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let tenantId: string;
  let sandboxId: string;

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
      .values({ slug: 't', name: 'T' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'o@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [admin] = await db
      .insert(schema.users)
      .values({ email: 'a@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    adminId = admin.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'm@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId: tenant.id, userId: ownerId, role: 'owner' },
      { tenantId: tenant.id, userId: adminId, role: 'admin' },
      { tenantId: tenant.id, userId: memberId, role: 'member' },
    ]);

    const { dek } = await ensureTenantDek(tenantId, { db: db as never, amk: AMK });
    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId: tenant.id,
        name: 'S',
        slug: 's',
        baseUrl: 'https://sb.example',
        tokenCiphertext: encryptSecret('old-token-value', dek),
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxId = sb.id;
  });

  it('owner rotates and re-encrypts under DEK', async () => {
    const res = await rotateSandboxToken(ownerId, sandboxId, 'brand-new-token', {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxId));
    const { dek, version } = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(decryptSecret(row.tokenCiphertext!, dek)).toBe('brand-new-token');
    expect(row.tokenKekVersion).toBe(version);
    // not decryptable with AMK
    expect(() => decryptSecret(row.tokenCiphertext!, AMK)).toThrow();
  });

  it('admin cannot rotate', async () => {
    const res = await rotateSandboxToken(adminId, sandboxId, 'x', {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects empty token', async () => {
    const res = await rotateSandboxToken(ownerId, sandboxId, '   ', {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'empty' });
  });

  it('member cannot rotate', async () => {
    const res = await rotateSandboxToken(memberId, sandboxId, 'x', {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('unknown sandbox is not_found', async () => {
    const res = await rotateSandboxToken(
      ownerId,
      '00000000-0000-4000-8000-000000000099',
      'x',
      { db: db as never, amk: AMK },
    );
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects rotate for vercel backend', async () => {
    const [vsb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'V',
        slug: 'vercel-sb',
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const res = await rotateSandboxToken(ownerId, vsb.id, 'nope', {
      db: db as never,
      amk: AMK,
    });
    expect(res).toEqual({ ok: false, reason: 'wrong_backend' });
  });
});
