import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { MAX_MCP_SERVERS_PER_USER } from '../mcp/limits';
import { decryptTenantSecret } from './tenantKeys';
import {
  createUserMcpServer,
  deleteUserMcpServer,
  listUserMcpServers,
  loadEnabledUserMcpSecrets,
  loadUserMcpSecretById,
  setUserMcpServerEnabled,
  setUserMcpServerLastError,
  updateUserMcpServer,
} from './userMcpServers';

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

const AMK = Buffer.alloc(32, 9);

describe('userMcpServers', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.userMcpServers);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

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

  it('creates with key → list mask only (no ciphertext)', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Exa',
        slug: 'exa',
        url: 'https://mcp.exa.ai/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'sk-test-secret-aaaa',
      },
      deps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);

    const listed = await listUserMcpServers(userId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value).toHaveLength(1);
    const row = listed.value[0];
    expect(row.hasApiKey).toBe(true);
    expect(row.apiKeyMask).toBe('••••••••aaaa');
    expect(row.authMode).toBe('api_key');
    expect(row.tenantId).toBe(tenantId);
    expect(JSON.stringify(row)).not.toMatch(/sk-test-secret/);
    expect(JSON.stringify(row)).not.toMatch(/ciphertext|v1:/i);

    const raw = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));
    expect(raw[0].authHeaderValueCiphertext).toBeTruthy();
    const plain = await decryptTenantSecret(
      tenantId,
      raw[0].authHeaderValueCiphertext!,
      deps(),
    );
    expect(plain).toBe('sk-test-secret-aaaa');
  });

  it('creates without key → auth_mode=none, null mask', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Public MCP',
        slug: 'public_mcp',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);

    const listed = await listUserMcpServers(userId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value[0].hasApiKey).toBe(false);
    expect(listed.value[0].apiKeyMask).toBeNull();
    expect(listed.value[0].authMode).toBe('none');
    expect(listed.value[0].authHeaderName).toBeNull();

    const raw = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));
    expect(raw[0].authHeaderValueCiphertext).toBeNull();
    expect(raw[0].authHeaderKekVersion).toBeNull();
  });

  it('update key rotates ciphertext under DEK', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Rot',
        slug: 'rot',
        url: 'https://example.com/mcp',
        authHeaderName: 'Authorization',
        apiKey: 'old-key-1111',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const before = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));

    const upd = await updateUserMcpServer(
      {
        userId,
        id: created.value.id,
        apiKey: 'new-key-2222',
        authHeaderName: 'Authorization',
      },
      deps(),
    );
    expect(upd.ok).toBe(true);

    const after = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));
    expect(after[0].authHeaderValueCiphertext).not.toBe(
      before[0].authHeaderValueCiphertext,
    );
    const plain = await decryptTenantSecret(
      tenantId,
      after[0].authHeaderValueCiphertext!,
      deps(),
    );
    expect(plain).toBe('new-key-2222');
  });

  it('update with empty apiKey keeps prior ciphertext', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Keep',
        slug: 'keep',
        url: 'https://example.com/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'keep-me-zzzz',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const before = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));

    const upd = await updateUserMcpServer(
      {
        userId,
        id: created.value.id,
        name: 'Keep Renamed',
        apiKey: '',
      },
      deps(),
    );
    expect(upd.ok).toBe(true);

    const after = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));
    expect(after[0].name).toBe('Keep Renamed');
    expect(after[0].authHeaderValueCiphertext).toBe(
      before[0].authHeaderValueCiphertext,
    );
  });

  it('cross-user isolation: A cannot update/delete B', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Mine',
        slug: 'mine',
        url: 'https://example.com/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'secret-bbbb',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);

    const upd = await updateUserMcpServer(
      { userId: otherUserId, id: created.value.id, name: 'Hijacked' },
      deps(),
    );
    expect(upd.ok).toBe(false);
    if (upd.ok) throw new Error('expected fail');
    expect(upd.code).toBe('not_found');

    const del = await deleteUserMcpServer(otherUserId, created.value.id, deps());
    expect(del.ok).toBe(false);
    if (del.ok) throw new Error('expected fail');
    expect(del.code).toBe('not_found');

    const still = await db
      .select()
      .from(schema.userMcpServers)
      .where(eq(schema.userMcpServers.id, created.value.id));
    expect(still[0].name).toBe('Mine');
  });

  it('max servers limit', async () => {
    for (let i = 0; i < MAX_MCP_SERVERS_PER_USER; i++) {
      const r = await createUserMcpServer(
        {
          userId,
          name: `S${i}`,
          slug: `s${i}`,
          url: 'https://example.com/mcp',
        },
        deps(),
      );
      expect(r.ok).toBe(true);
    }
    const over = await createUserMcpServer(
      {
        userId,
        name: 'Over',
        slug: 'over',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('expected fail');
    expect(over.code).toBe('limit_exceeded');
  });

  it('rejects bad urls', async () => {
    const r = await createUserMcpServer(
      {
        userId,
        name: 'Bad',
        slug: 'bad',
        url: 'http://example.com/mcp',
      },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.code).toBe('invalid_url');
  });

  it('rejects invalid slug / header / name', async () => {
    const slug = await createUserMcpServer(
      {
        userId,
        name: 'X',
        slug: 'Bad-Slug',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(slug.ok).toBe(false);
    if (slug.ok) throw new Error('expected fail');
    expect(slug.code).toBe('invalid_slug');

    const header = await createUserMcpServer(
      {
        userId,
        name: 'Y',
        slug: 'y',
        url: 'https://example.com/mcp',
        authHeaderName: 'x api key\n',
        apiKey: 'secret',
      },
      deps(),
    );
    expect(header.ok).toBe(false);
    if (header.ok) throw new Error('expected fail');
    expect(header.code).toBe('invalid_header');

    const name = await createUserMcpServer(
      {
        userId,
        name: '',
        slug: 'z',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(name.ok).toBe(false);
    if (name.ok) throw new Error('expected fail');
    expect(name.code).toBe('invalid_name');
  });

  it('no membership → create fails', async () => {
    const [stranger] = await db
      .insert(schema.users)
      .values({ email: 'stranger@example.com', status: 'active' })
      .returning({ id: schema.users.id });

    const r = await createUserMcpServer(
      {
        userId: stranger.id,
        name: 'Nope',
        slug: 'nope',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.code).toBe('no_membership');
  });

  it('duplicate name and slug', async () => {
    const a = await createUserMcpServer(
      {
        userId,
        name: 'Dup',
        slug: 'dup',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(a.ok).toBe(true);

    const nameDup = await createUserMcpServer(
      {
        userId,
        name: 'Dup',
        slug: 'other',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(nameDup.ok).toBe(false);
    if (nameDup.ok) throw new Error('expected fail');
    expect(nameDup.code).toBe('duplicate_name');

    const slugDup = await createUserMcpServer(
      {
        userId,
        name: 'Other',
        slug: 'dup',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    expect(slugDup.ok).toBe(false);
    if (slugDup.ok) throw new Error('expected fail');
    expect(slugDup.code).toBe('duplicate_slug');
  });

  it('create with enabled:false is atomic (not in loadEnabled)', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Disabled',
        slug: 'disabled_at_create',
        url: 'https://example.com/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'disabled-key-0001',
        enabled: false,
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);

    const listed = await listUserMcpServers(userId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0].enabled).toBe(false);

    const secrets = await loadEnabledUserMcpSecrets(userId, deps());
    expect(secrets.ok).toBe(true);
    if (!secrets.ok) throw new Error(secrets.error);
    expect(secrets.value).toHaveLength(0);
  });

  it('set enabled + loadEnabledUserMcpSecrets decrypts', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Runtime',
        slug: 'runtime',
        url: 'https://example.com/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'runtime-key-9999',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);

    const secrets = await loadEnabledUserMcpSecrets(userId, deps());
    expect(secrets.ok).toBe(true);
    if (!secrets.ok) throw new Error(secrets.error);
    expect(secrets.value).toHaveLength(1);
    expect(secrets.value[0].apiKey).toBe('runtime-key-9999');

    await setUserMcpServerEnabled(userId, created.value.id, false, deps());
    const after = await loadEnabledUserMcpSecrets(userId, deps());
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error);
    expect(after.value).toHaveLength(0);
  });

  it('delete removes row', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Gone',
        slug: 'gone',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const del = await deleteUserMcpServer(userId, created.value.id, deps());
    expect(del.ok).toBe(true);
    const listed = await listUserMcpServers(userId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value).toHaveLength(0);
  });

  it('setUserMcpServerLastError updates and clears', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Err',
        slug: 'err',
        url: 'https://example.com/mcp',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const set = await setUserMcpServerLastError(
      userId,
      created.value.id,
      'connect failed',
      deps(),
    );
    expect(set.ok).toBe(true);
    const listed = await listUserMcpServers(userId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value[0].lastError).toBe('connect failed');

    await setUserMcpServerLastError(userId, created.value.id, null, deps());
    const after = await listUserMcpServers(userId, deps());
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.error);
    expect(after.value[0].lastError).toBeNull();
  });

  it('loadUserMcpSecretById returns decrypted key for owner', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Exa',
        slug: 'exa',
        url: 'https://mcp.exa.ai/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'secret-key-zzzz',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const loaded = await loadUserMcpSecretById(
      userId,
      created.value.id,
      deps(),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.apiKey).toBe('secret-key-zzzz');
    expect(loaded.value.url).toContain('exa');
  });

  it('loadUserMcpSecretById rejects foreign user', async () => {
    const created = await createUserMcpServer(
      {
        userId,
        name: 'Mine',
        slug: 'mine',
        url: 'https://example.com/mcp',
        authHeaderName: 'x-api-key',
        apiKey: 'nope-for-other',
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const foreign = await loadUserMcpSecretById(
      otherUserId,
      created.value.id,
      deps(),
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) throw new Error('expected fail');
    expect(foreign.code).toBe('not_found');
  });

});
