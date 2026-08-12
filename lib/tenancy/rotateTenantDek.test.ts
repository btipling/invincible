import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import * as schema from '../../db/schema';
import { decryptSecret, encryptSecret } from './credentials';
import { rotateTenantDek } from './rotateTenantDek';
import { ensureTenantDek, loadTenantDek } from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

const FULL_MIGRATIONS = [
  '0000_tenancy_phase1.sql',
  '0001_sso_scim_identity.sql',
  '0002_tenant_deks.sql',
  '0003_provider_secrets.sql',
  '0004_user_mcp_servers.sql',
  '0005_sandbox_backend.sql',
  '0006_user_github_tokens.sql',
  '0007_user_preferred_sandbox.sql',
];

/**
 * Apply each migration file as a single multi-statement exec (still in file
 * order) rather than one round-trip per `--> statement-breakpoint` chunk.
 * PGlite `exec` runs several semicolon-separated statements; the breakpoint
 * markers are a drizzle artifact and safe to drop.
 */
async function applyMigrations(client: PGlite, names: string[]) {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
      .split('--> statement-breakpoint')
      .join('')
      .trim();
    if (sql) {
      await client.exec(sql);
    }
  }
}

const AMK = Buffer.alloc(32, 5);

/**
 * One in-memory PGlite for the whole file, booted once. This cuts the second
 * cold WASM Postgres start (previously one per describe) and reduces the
 * migration cost to a single round-trip per file instead of one per
 * `--> statement-breakpoint` chunk. Note: test transactions must be isolated
 * via the delete-and-reseed beforeEach below — PGlite's single-connection
 * mutex deadlocks when a raw SAVEPOINT/transaction straddles drizzle calls
 * against the shared `db`.
 */
let client!: PGlite;
let db!: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  await applyMigrations(client, FULL_MIGRATIONS);
  db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

describe('rotateTenantDek', () => {
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let tenantId: string;
  let otherTenantId: string;
  let sandboxA1: string;
  let sandboxA2: string;
  let sandboxB: string;

  beforeEach(async () => {
    await db.delete(schema.userGithubTokens);
    await db.delete(schema.userMcpServers);
    await db.delete(schema.providerSecretGrants);
    await db.delete(schema.providerSecretModels);
    await db.delete(schema.providerSecrets);
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

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

    await db.insert(schema.providerSecrets).values({
      tenantId,
      name: 'anthropic-prod',
      provider: 'anthropic',
      credentialCiphertext: encryptSecret(
        JSON.stringify({ apiKey: 'sk-rotate-me' }),
        dek,
      ),
      credentialKekVersion: 1,
      status: 'active',
    });

    await db.insert(schema.userMcpServers).values([
      {
        tenantId,
        userId: ownerId,
        name: 'Exa',
        slug: 'exa',
        url: 'https://mcp.exa.ai/mcp',
        transport: 'http',
        authHeaderName: 'x-api-key',
        authHeaderValueCiphertext: encryptSecret('mcp-key-rotate', dek),
        authHeaderKekVersion: 1,
        authMode: 'api_key',
        enabled: true,
      },
      {
        tenantId,
        userId: ownerId,
        name: 'Public',
        slug: 'public',
        url: 'https://example.com/mcp',
        transport: 'http',
        authHeaderName: null,
        authHeaderValueCiphertext: null,
        authHeaderKekVersion: null,
        authMode: 'none',
        enabled: true,
      },
    ]);

    await db.insert(schema.userGithubTokens).values({
      userId: ownerId,
      tenantId,
      tokenCiphertext: encryptSecret('ghp_pat_rotate_test', dek),
      tokenKekVersion: 1,
    });
  });

  it('owner rotates: re-encrypts sandboxes + provider_secrets + MCP + GitHub PAT; old DEK fails', async () => {
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
    expect(decryptSecret(byId[sandboxA1].tokenCiphertext!, after.dek)).toBe(
      'token-a1',
    );
    expect(decryptSecret(byId[sandboxA2].tokenCiphertext!, after.dek)).toBe(
      'token-a2',
    );
    expect(byId[sandboxA1].tokenKekVersion).toBe(2);
    expect(byId[sandboxA2].tokenKekVersion).toBe(2);
    expect(() =>
      decryptSecret(byId[sandboxA1].tokenCiphertext!, before.dek),
    ).toThrow();

    const secrets = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.tenantId, tenantId));
    expect(secrets).toHaveLength(1);
    expect(secrets[0].credentialKekVersion).toBe(2);
    const plain = decryptSecret(secrets[0].credentialCiphertext, after.dek);
    expect(JSON.parse(plain)).toEqual({ apiKey: 'sk-rotate-me' });
    expect(() =>
      decryptSecret(secrets[0].credentialCiphertext, before.dek),
    ).toThrow();

    const mcpRows = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.tenantId, tenantId));
    expect(mcpRows).toHaveLength(2);
    const withKey = mcpRows.find((r) => r.slug === 'exa')!;
    const noKey = mcpRows.find((r) => r.slug === 'public')!;
    expect(withKey.authHeaderKekVersion).toBe(2);
    expect(decryptSecret(withKey.authHeaderValueCiphertext!, after.dek)).toBe(
      'mcp-key-rotate',
    );
    expect(() =>
      decryptSecret(withKey.authHeaderValueCiphertext!, before.dek),
    ).toThrow();
    expect(noKey.authHeaderValueCiphertext).toBeNull();
    expect(noKey.authHeaderKekVersion).toBeNull();

    const ghRows = await db
      .select()
      .from(schema.userGithubTokens)
      .where(eq(schema.userGithubTokens.tenantId, tenantId));
    expect(ghRows).toHaveLength(1);
    expect(ghRows[0].tokenKekVersion).toBe(2);
    expect(decryptSecret(ghRows[0].tokenCiphertext!, after.dek)).toBe(
      'ghp_pat_rotate_test',
    );
    expect(() =>
      decryptSecret(ghRows[0].tokenCiphertext!, before.dek),
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
    expect(decryptSecret(sbAfter.tokenCiphertext!, otherAfter.dek)).toBe(
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
    expect(decryptSecret(a1After.tokenCiphertext!, before.dek)).toBe('token-a1');
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
    expect(decryptSecret(row.tokenCiphertext!, after.dek)).toBe(
      'legacy-amk-token',
    );
    expect(() => decryptSecret(row.tokenCiphertext!, AMK)).toThrow();
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
    expect(decryptSecret(a2After.tokenCiphertext!, before.dek)).toBe('token-a2');
  });

  it('skips null/empty tokenCiphertext (vercel rows) while rotating BYO', async () => {
    const [vercelSb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Vercel',
        slug: 'vercel',
        backend: 'vercel',
        image: 'vercel/sandbox/universal:latest',
        baseUrl: null,
        tokenCiphertext: null,
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    // empty string ciphertext must also skip (not throw)
    const [emptySb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'EmptyCt',
        slug: 'empty-ct',
        backend: 'byo',
        baseUrl: 'https://empty.example',
        tokenCiphertext: '   ',
        tokenKekVersion: 1,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });

    const before = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: true, dekVersion: before.version + 1 });

    const after = await loadTenantDek(tenantId, {
      db: db as never,
      amk: AMK,
    });
    expect(after.version).toBe(before.version + 1);

    const [vercelAfter] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, vercelSb.id));
    expect(vercelAfter.tokenCiphertext).toBeNull();
    expect(vercelAfter.baseUrl).toBeNull();
    expect(vercelAfter.tokenKekVersion).toBe(1);

    const [emptyAfter] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, emptySb.id));
    expect(emptyAfter.tokenCiphertext?.trim() ?? '').toBe('');
    expect(emptyAfter.tokenKekVersion).toBe(1);

    // BYO rows still re-encrypted under new DEK
    const [a1After] = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxA1));
    expect(decryptSecret(a1After.tokenCiphertext!, after.dek)).toBe('token-a1');
    expect(a1After.tokenKekVersion).toBe(after.version);
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

describe('rotateTenantDek without user_github_tokens table', () => {
  let ownerId: string;
  let tenantId: string;

  beforeAll(async () => {
    // Simulate deploy-before-migrate for 0006: drop the github table from the
    // shared engine (PGlite has no schema-migration-version bookkeeping that
    // must be kept in sync here, and no other table references it).
    await client.exec('DROP TABLE IF EXISTS "user_github_tokens"');
  });

  it('owner rotate succeeds (deploy-before-migrate soft-skip)', async () => {
    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'pre-gh', name: 'Pre GH' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;
    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'pre-gh-owner@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    ownerId = owner.id;
    await db.insert(schema.tenantMembers).values({
      tenantId,
      userId: ownerId,
      role: 'owner',
    });

    const dek = await ensureTenantDek(tenantId, { db: db as never, amk: AMK });
    await db.insert(schema.sandboxes).values({
      tenantId,
      name: 'box',
      slug: 'box',
      baseUrl: 'https://sandbox.example',
      tokenCiphertext: encryptSecret('tok-pre-gh', dek.dek),
      tokenKekVersion: dek.version,
    });

    const res = await rotateTenantDek(ownerId, tenantId, {
      db: db as never,
      amk: AMK,
      mode: 'dek-only',
    });
    expect(res).toEqual({ ok: true, dekVersion: dek.version + 1 });

    const after = await loadTenantDek(tenantId, { db: db as never, amk: AMK });
    const rows = await db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0].tokenCiphertext!, after.dek)).toBe('tok-pre-gh');
  });
});
