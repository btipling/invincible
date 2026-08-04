import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import { SANDBOX_FORBIDDEN_ERROR } from './errors';
import { resolveAgentSandbox } from './resolveSandbox';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of ['0000_tenancy_phase1.sql', '0001_sso_scim_identity.sql', '0002_tenant_deks.sql']) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
}

const KEY = Buffer.alloc(32, 9);

function decryptWithKey(ct: string): string {
  return decryptSecret(ct, KEY);
}

function stubClient(meta?: { baseUrl: string; token: string }) {
  return {
    listDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    exec: vi.fn(),
    __meta: meta,
  } as never;
}

describe('resolveAgentSandbox', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;
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

    const ciphertext = encryptSecret('sandbox-token-secret-xyz', KEY);
    const [sandbox] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'default',
        slug: 'default',
        baseUrl: 'http://127.0.0.1:8787/',
        tokenCiphertext: ciphertext,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxId = sandbox.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId,
      userId,
      canRead: true,
      canWrite: true,
    });
  });

  it('resolves single membership + full grant', async () => {
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
      createClient: ({ baseUrl, token }) => stubClient({ baseUrl, token }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.sandboxId).toBe(sandboxId);
    expect(result.value.tenantId).toBe(tenantId);
    expect(result.value.permissions).toEqual({ canRead: true, canWrite: true });
    expect(result.value.secrets).toContain('sandbox-token-secret-xyz');
    expect(result.value.baseUrl).toBe('http://127.0.0.1:8787');
    expect((result.value.client as { __meta?: { token: string } }).__meta?.token).toBe(
      'sandbox-token-secret-xyz',
    );
  });

  it('write-only grant gets effective read', async () => {
    await db
      .update(schema.sandboxGrants)
      .set({ canRead: false, canWrite: true })
      .where(eq(schema.sandboxGrants.userId, userId));

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
      createClient: () => stubClient(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.permissions).toEqual({ canRead: true, canWrite: true });
  });

  it('403 when zero memberships', async () => {
    await db.delete(schema.tenantMembers);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({ error: SANDBOX_FORBIDDEN_ERROR });
  });

  it('403 when two memberships', async () => {
    const [t2] = await db
      .insert(schema.tenants)
      .values({ slug: 't2', name: 'T2' })
      .returning({ id: schema.tenants.id });
    await db.insert(schema.tenantMembers).values({
      tenantId: t2.id,
      userId,
      role: 'member',
    });
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('403 when sandbox inactive', async () => {
    await db
      .update(schema.sandboxes)
      .set({ status: 'disabled' })
      .where(eq(schema.sandboxes.id, sandboxId));
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('403 when zero-permission grant (not usable)', async () => {
    await db
      .update(schema.sandboxGrants)
      .set({ canRead: false, canWrite: false })
      .where(eq(schema.sandboxGrants.userId, userId));
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: decryptWithKey,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('403 on decrypt failure without leaking crypto detail', async () => {
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decrypt: () => {
        throw new Error('decryption failed secret-key-material');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe(SANDBOX_FORBIDDEN_ERROR);
    expect(JSON.stringify(body)).not.toContain('secret-key');
    expect(JSON.stringify(body)).not.toContain('decryption');
  });

  it('403 for empty userId', async () => {
    const result = await resolveAgentSandbox('  ', { db: db as never });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });
});
