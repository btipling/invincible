import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  createProviderSecret,
  disableProviderSecret,
  listProviderSecretsForAdmin,
  setProviderSecretGrants,
  setProviderSecretModels,
  updateProviderSecret,
} from './providerSecrets';
import { decryptTenantSecret } from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
    '0003_provider_secrets.sql',
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

describe('providerSecrets', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let userId: string;
  let otherUserId: string;
  let foreignUserId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.providerSecretGrants);
    await db.delete(schema.providerSecretModels);
    await db.delete(schema.providerSecrets);
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

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'member@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    otherUserId = member.id;

    const [foreign] = await db
      .insert(schema.users)
      .values({ email: 'foreign@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    foreignUserId = foreign.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId, role: 'owner' },
      { tenantId, userId: otherUserId, role: 'member' },
    ]);
  });

  const deps = () => ({ db: db as never, amk: AMK });

  it('creates secret under DEK; list returns mask only', async () => {
    const created = await createProviderSecret(
      {
        tenantId,
        name: ' Anthropic prod ',
        provider: 'anthropic',
        credentials: { apiKey: 'sk-ant-secret-key-xyz' },
      },
      deps(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');

    const listed = await listProviderSecretsForAdmin(tenantId, deps());
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error('list failed');
    expect(listed.value).toHaveLength(1);
    const row = listed.value[0];
    expect(row.name).toBe('Anthropic prod');
    expect(row.credentialMask).toMatch(/xyz$/);
    expect(JSON.stringify(row)).not.toContain('sk-ant-secret-key-xyz');
    expect(JSON.stringify(row)).not.toContain('credentialCiphertext');

    const raw = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.id, created.value.id));
    expect(raw[0].credentialCiphertext).not.toContain('sk-ant');
    const plain = await decryptTenantSecret(
      tenantId,
      raw[0].credentialCiphertext,
      deps(),
    );
    expect(JSON.parse(plain)).toEqual({ apiKey: 'sk-ant-secret-key-xyz' });

    // DEK was provisioned
    const t = await db
      .select({ dek: schema.tenants.dekCiphertext })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    expect(t[0].dek).toBeTruthy();
  });

  it('creates secret when DEK missing (ensureTenantDek)', async () => {
    const t = await db
      .select({ dek: schema.tenants.dekCiphertext })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    expect(t[0].dek).toBeNull();

    const created = await createProviderSecret(
      {
        tenantId,
        name: 'key1',
        provider: 'openai',
        credentials: { apiKey: 'sk-oai' },
      },
      deps(),
    );
    expect(created.ok).toBe(true);
  });

  it('rejects duplicate name per tenant', async () => {
    const a = await createProviderSecret(
      {
        tenantId,
        name: 'same',
        provider: 'openai',
        credentials: { apiKey: 'a' },
      },
      deps(),
    );
    expect(a.ok).toBe(true);
    const b = await createProviderSecret(
      {
        tenantId,
        name: 'same',
        provider: 'openai',
        credentials: { apiKey: 'b' },
      },
      deps(),
    );
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('expected fail');
    expect(b.code).toBe('duplicate_name');
  });

  it('setModels replaces full set; rejects invalid model_id', async () => {
    const created = await createProviderSecret(
      {
        tenantId,
        name: 'm',
        provider: 'anthropic',
        credentials: { apiKey: 'k' },
      },
      deps(),
    );
    if (!created.ok) throw new Error('create');
    const id = created.value.id;

    const bad = await setProviderSecretModels(id, ['UPPER/model'], tenantId, deps());
    expect(bad.ok).toBe(false);

    // Bare model names are prefixed with the secret provider.
    const bare = await setProviderSecretModels(
      id,
      ['claude-a', 'anthropic/claude-b'],
      tenantId,
      deps(),
    );
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.value.modelIds).toEqual(['anthropic/claude-a', 'anthropic/claude-b']);
    }

    const ok1 = await setProviderSecretModels(
      id,
      ['anthropic/claude-a', 'anthropic/claude-b'],
      tenantId,
      deps(),
    );
    expect(ok1.ok).toBe(true);

    const ok2 = await setProviderSecretModels(id, ['anthropic/claude-c'], tenantId, deps());
    expect(ok2.ok).toBe(true);

    const models = await db
      .select()
      .from(schema.providerSecretModels)
      .where(eq(schema.providerSecretModels.secretId, id));
    expect(models.map((m) => m.modelId)).toEqual(['anthropic/claude-c']);
  });

  it('setGrants replaces; rejects foreign user without partial write', async () => {
    const created = await createProviderSecret(
      {
        tenantId,
        name: 'g',
        provider: 'openai',
        credentials: { apiKey: 'k' },
      },
      deps(),
    );
    if (!created.ok) throw new Error('create');
    const id = created.value.id;

    const ok = await setProviderSecretGrants(
      id,
      [{ userId, canUse: true }],
      tenantId,
      deps(),
    );
    expect(ok.ok).toBe(true);

    const fail = await setProviderSecretGrants(
      id,
      [
        { userId: otherUserId, canUse: true },
        { userId: foreignUserId, canUse: true },
      ],
      tenantId,
      deps(),
    );
    expect(fail.ok).toBe(false);
    if (fail.ok) throw new Error('expected fail');
    expect(fail.code).toBe('foreign_user');

    const grants = await db
      .select()
      .from(schema.providerSecretGrants)
      .where(eq(schema.providerSecretGrants.secretId, id));
    // previous grants preserved (no partial write of the failed set)
    expect(grants).toHaveLength(1);
    expect(grants[0].userId).toBe(userId);

    const replace = await setProviderSecretGrants(
      id,
      [{ userId: otherUserId, canUse: false }],
      tenantId,
      deps(),
    );
    expect(replace.ok).toBe(true);
    const after = await db
      .select()
      .from(schema.providerSecretGrants)
      .where(eq(schema.providerSecretGrants.secretId, id));
    expect(after).toHaveLength(1);
    expect(after[0].userId).toBe(otherUserId);
    expect(after[0].canUse).toBe(false);
  });

  it('disable secret', async () => {
    const created = await createProviderSecret(
      {
        tenantId,
        name: 'd',
        provider: 'bedrock',
        credentials: { accessKeyId: 'AKI', secretAccessKey: 'sec' },
      },
      deps(),
    );
    if (!created.ok) throw new Error('create');
    const r = await disableProviderSecret(created.value.id, tenantId, deps());
    expect(r.ok).toBe(true);
    const row = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.id, created.value.id));
    expect(row[0].status).toBe('disabled');
  });

  it('update credentials rotates ciphertext', async () => {
    const created = await createProviderSecret(
      {
        tenantId,
        name: 'rot',
        provider: 'anthropic',
        credentials: { apiKey: 'old-key-aaaa' },
      },
      deps(),
    );
    if (!created.ok) throw new Error('create');
    const before = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.id, created.value.id));
    await updateProviderSecret(
      {
        secretId: created.value.id,
        tenantId,
        credentials: { apiKey: 'new-key-bbbb' },
      },
      deps(),
    );
    const after = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.id, created.value.id));
    expect(after[0].credentialCiphertext).not.toBe(
      before[0].credentialCiphertext,
    );
    const plain = await decryptTenantSecret(
      tenantId,
      after[0].credentialCiphertext,
      deps(),
    );
    expect(JSON.parse(plain)).toEqual({ apiKey: 'new-key-bbbb' });
  });

  it('rejects mutations for secret outside tenantId', async () => {
    const [otherTenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'other-tenant', name: 'Other' })
      .returning({ id: schema.tenants.id });

    const foreign = await createProviderSecret(
      {
        tenantId: otherTenant.id,
        name: 'foreign-secret',
        provider: 'anthropic',
        credentials: { apiKey: 'foreign-key' },
      },
      deps(),
    );
    if (!foreign.ok) throw new Error(foreign.error);
    const fid = foreign.value.id;

    const upd = await updateProviderSecret(
      { secretId: fid, tenantId, name: 'hijacked' },
      deps(),
    );
    expect(upd.ok).toBe(false);
    if (upd.ok) throw new Error('expected fail');
    expect(upd.code).toBe('not_found');

    const dis = await disableProviderSecret(fid, tenantId, deps());
    expect(dis.ok).toBe(false);
    if (dis.ok) throw new Error('expected fail');
    expect(dis.code).toBe('not_found');

    const models = await setProviderSecretModels(
      fid,
      ['anthropic/claude-x'],
      tenantId,
      deps(),
    );
    expect(models.ok).toBe(false);
    if (models.ok) throw new Error('expected fail');
    expect(models.code).toBe('not_found');

    const grants = await setProviderSecretGrants(
      fid,
      [{ userId, canUse: true }],
      tenantId,
      deps(),
    );
    expect(grants.ok).toBe(false);
    if (grants.ok) throw new Error('expected fail');
    expect(grants.code).toBe('not_found');

    const still = await db
      .select()
      .from(schema.providerSecrets)
      .where(eq(schema.providerSecrets.id, fid));
    expect(still[0].name).toBe('foreign-secret');
    expect(still[0].status).toBe('active');
  });

});
