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
  setProviderSecretGrants,
  setProviderSecretModels,
} from './providerSecrets';
import { resolveByokForRequest } from './resolveInferenceForRequest';

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

const AMK = Buffer.alloc(32, 9);

describe('resolveByokForRequest', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let memberId: string;

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
      .values({ slug: 't', name: 'T' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'm@t.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: memberId, role: 'member' },
    ]);
  });

  const deps = () => ({ db: db as never, amk: AMK });

  async function seed(models: string[]) {
    const created = await createProviderSecret(
      {
        tenantId,
        name: 'k',
        provider: 'anthropic',
        credentials: { apiKey: 'sk-req' },
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    await setProviderSecretModels(created.value.id, models, tenantId, deps());
    await setProviderSecretGrants(
      created.value.id,
      [{ userId: memberId, canUse: true }],
      tenantId,
      deps(),
    );
  }

  it('omitted modelId uses first granted (ASC)', async () => {
    await seed(['anthropic/claude-z', 'anthropic/claude-a']);
    const r = await resolveByokForRequest(memberId, undefined, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.modelId).toBe('anthropic/claude-a');
    expect(r.byok.anthropic[0]).toEqual({ apiKey: 'sk-req' });
  });

  it('empty catalog → forbidden', async () => {
    const r = await resolveByokForRequest(memberId, undefined, deps());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('forbidden');
  });

  it('explicit modelId resolves', async () => {
    await seed(['anthropic/claude-a']);
    const r = await resolveByokForRequest(
      memberId,
      'anthropic/claude-a',
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.secretsToRedact).toContain('sk-req');
  });

  it('catalog db failure → unavailable (not forbidden)', async () => {
    const badDb = {
      select: () => {
        throw new Error('db down');
      },
    };
    const r = await resolveByokForRequest(memberId, undefined, {
      db: badDb as never,
      amk: AMK,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('unavailable');
  });
});
