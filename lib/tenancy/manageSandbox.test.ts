import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import {
  createSandboxForAdmin,
  updateSandboxForAdmin,
} from './manageSandbox';
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
    '0006_user_github_tokens.sql',
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

const AMK = Buffer.alloc(32, 7);

describe('manageSandbox', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ownerId: string;
  let memberId: string;
  let tenantId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
    process.env.CREDENTIALS_ENCRYPTION_KEY = AMK.toString('base64');
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

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'm@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: memberId, role: 'member' },
    ]);
  });

  it('create byo requires token and URL', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'A',
        slug: 'a',
        backend: 'byo',
        baseUrl: 'https://sb.example',
        token: '',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('validation');
  });

  it('create vercel without token; image null OK', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'V',
        slug: 'v',
        backend: 'vercel',
        image: null,
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, r.sandboxId));
    expect(rows[0].backend).toBe('vercel');
    expect(rows[0].baseUrl).toBeNull();
    expect(rows[0].tokenCiphertext).toBeNull();
    expect(rows[0].image).toBeNull();
  });

  it('create vercel custom image stores ref', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'V',
        slug: 'v2',
        backend: 'vercel',
        image: 'vercel/sandbox/node:24',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, r.sandboxId));
    expect(rows[0].image).toBe('vercel/sandbox/node:24');
  });

  it('invalid image rejected', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'V',
        slug: 'bad',
        backend: 'vercel',
        image: 'bad image with spaces',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('validation');
    expect(r.error).not.toMatch(/secret/i);
  });

  it('create revokes actor other grants; sole R/W on new', async () => {
    const { dek, version } = await ensureTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const ct = encryptSecret('old-token', dek);
    const [old] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Old',
        slug: 'old',
        backend: 'byo',
        baseUrl: 'https://old.example',
        tokenCiphertext: ct,
        tokenKekVersion: version,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    await db.insert(schema.sandboxGrants).values({
      sandboxId: old.id,
      userId: ownerId,
      canRead: true,
      canWrite: true,
    });

    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'New',
        slug: 'new',
        backend: 'vercel',
        image: 'vercel/sandbox/python:3.14',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');

    const grants = await db
      .select()
      .from(schema.sandboxGrants)
      .where(eq(schema.sandboxGrants.userId, ownerId));
    expect(grants).toHaveLength(1);
    expect(grants[0].sandboxId).toBe(r.sandboxId);
    expect(grants[0].canWrite).toBe(true);
  });

  it('member cannot create', async () => {
    const r = await createSandboxForAdmin(
      memberId,
      { name: 'X', slug: 'x', backend: 'vercel' },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('forbidden');
  });

  it('update byo→vercel clears URL/token; image set', async () => {
    const { dek, version } = await ensureTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const ct = encryptSecret('tok', dek);
    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'B',
        slug: 'b',
        backend: 'byo',
        baseUrl: 'https://b.example',
        tokenCiphertext: ct,
        tokenKekVersion: version,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const r = await updateSandboxForAdmin(
      ownerId,
      {
        sandboxId: sb.id,
        backend: 'vercel',
        image: 'vercel/sandbox/ubuntu:latest',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sb.id));
    expect(rows[0].backend).toBe('vercel');
    expect(rows[0].baseUrl).toBeNull();
    expect(rows[0].tokenCiphertext).toBeNull();
    expect(rows[0].image).toBe('vercel/sandbox/ubuntu:latest');
  });

  it('create byo encrypts token under DEK', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'Byo',
        slug: 'byo1',
        backend: 'byo',
        baseUrl: 'https://byo.example',
        token: 'plain-secret-token',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, r.sandboxId));
    expect(rows[0].tokenCiphertext).toBeTruthy();
    expect(rows[0].tokenCiphertext).not.toContain('plain-secret-token');
    const grants = await db
      .select()
      .from(schema.sandboxGrants)
      .where(
        and(
          eq(schema.sandboxGrants.sandboxId, r.sandboxId),
          eq(schema.sandboxGrants.userId, ownerId),
        ),
      );
    expect(grants).toHaveLength(1);
  });

  it('update leave token blank keeps ciphertext', async () => {
    const { dek, version } = await ensureTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const ct = encryptSecret('keep-me-token', dek);
    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Keep',
        slug: 'keep',
        backend: 'byo',
        baseUrl: 'https://keep.example',
        tokenCiphertext: ct,
        tokenKekVersion: version,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const r = await updateSandboxForAdmin(
      ownerId,
      {
        sandboxId: sb.id,
        name: 'Keep Renamed',
        // token omitted
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(true);
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sb.id));
    expect(rows[0].name).toBe('Keep Renamed');
    expect(rows[0].tokenCiphertext).toBe(ct);
    const loaded = await loadTenantDek(tenantId, { db: db as never, amk: AMK });
    expect(decryptSecret(rows[0].tokenCiphertext!, loaded.dek)).toBe('keep-me-token');
  });

  it('member cannot update', async () => {
    const { dek, version } = await ensureTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'M',
        slug: 'm',
        backend: 'byo',
        baseUrl: 'https://m.example',
        tokenCiphertext: encryptSecret('t', dek),
        tokenKekVersion: version,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const r = await updateSandboxForAdmin(
      memberId,
      { sandboxId: sb.id, name: 'Nope' },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('forbidden');
  });

  it('update vercel→byo requires URL and token', async () => {
    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'V',
        slug: 'vswitch',
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const missing = await updateSandboxForAdmin(
      ownerId,
      { sandboxId: sb.id, backend: 'byo', baseUrl: 'https://new.example' },
      { db: db as never, amk: AMK },
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected fail');
    expect(missing.reason).toBe('validation');

    const ok = await updateSandboxForAdmin(
      ownerId,
      {
        sandboxId: sb.id,
        backend: 'byo',
        baseUrl: 'https://new.example',
        token: 'new-plain-token',
      },
      { db: db as never, amk: AMK },
    );
    expect(ok.ok).toBe(true);
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sb.id));
    expect(rows[0].backend).toBe('byo');
    expect(rows[0].baseUrl).toBe('https://new.example');
    expect(rows[0].image).toBeNull();
    expect(rows[0].tokenCiphertext).toBeTruthy();
  });

  it('rejects non-http(s) BYO base URL on create', async () => {
    const r = await createSandboxForAdmin(
      ownerId,
      {
        name: 'Bad',
        slug: 'badurl',
        backend: 'byo',
        baseUrl: 'not-a-url',
        token: 'tok',
      },
      { db: db as never, amk: AMK },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('validation');
    expect(r.error).toMatch(/http/i);
  });

  it('slug conflict returns conflict', async () => {
    const a = await createSandboxForAdmin(
      ownerId,
      {
        name: 'One',
        slug: 'dup',
        backend: 'vercel',
      },
      { db: db as never, amk: AMK },
    );
    expect(a.ok).toBe(true);
    const b = await createSandboxForAdmin(
      ownerId,
      {
        name: 'Two',
        slug: 'dup',
        backend: 'vercel',
      },
      { db: db as never, amk: AMK },
    );
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('expected fail');
    expect(b.reason).toBe('conflict');
  });
});
