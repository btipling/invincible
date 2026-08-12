import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  createProviderSecret,
  setProviderSecretGrants,
  setProviderSecretModels,
  updateProviderSecret,
} from './providerSecrets';
import { listModelsForUser, resolveByokForModel } from './resolveInference';
import { getSharedDb, resetTenantTables } from './test/shared';

const AMK = Buffer.alloc(32, 3);

let db!: ReturnType<typeof drizzle<typeof schema>>;
let tenantId: string;
let ownerId: string;
let memberId: string;

describe('resolveInference', () => {
  beforeAll(async () => {
    db = await getSharedDb();
  });

  beforeEach(async () => {
    await resetTenantTables();

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 't', name: 'T' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [owner] = await db
      .insert(schema.users)
      .values({ email: 'owner@t.com', status: 'active' })
      .returning({ id: schema.users.id });
    ownerId = owner.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'member@t.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: memberId, role: 'member' },
    ]);
  });

  const deps = () => ({ db: db as never, amk: AMK });

  async function seedSecret(opts: {
    name: string;
    provider: string;
    credentials: unknown;
    models: string[];
    grants: { userId: string; canUse: boolean }[];
    status?: 'active' | 'disabled';
    createdAt?: Date;
  }) {
    const created = await createProviderSecret(
      {
        tenantId,
        name: opts.name,
        provider: opts.provider,
        credentials: opts.credentials,
      },
      deps(),
    );
    if (!created.ok) throw new Error(created.error);
    const id = created.value.id;
    if (opts.createdAt) {
      await db
        .update(schema.providerSecrets)
        .set({ createdAt: opts.createdAt })
        .where(eq(schema.providerSecrets.id, id));
    }
    const m = await setProviderSecretModels(id, opts.models, tenantId, deps());
    if (!m.ok) throw new Error(m.error);
    const g = await setProviderSecretGrants(id, opts.grants, tenantId, deps());
    if (!g.ok) throw new Error(g.error);
    if (opts.status === 'disabled') {
      await updateProviderSecret({ secretId: id, tenantId, status: 'disabled' }, deps());
    }
    return id;
  }

  it('grants filter catalog; empty without grant', async () => {
    await seedSecret({
      name: 'a',
      provider: 'anthropic',
      credentials: { apiKey: 'k1' },
      models: ['anthropic/claude-z', 'anthropic/claude-a'],
      grants: [{ userId: memberId, canUse: true }],
    });

    expect(await listModelsForUser(ownerId, deps())).toEqual([]);
    expect(await listModelsForUser(memberId, deps())).toEqual([
      'anthropic/claude-a',
      'anthropic/claude-z',
    ]);
  });

  it('owner without grant cannot resolve (no admin bypass)', async () => {
    await seedSecret({
      name: 'a',
      provider: 'anthropic',
      credentials: { apiKey: 'k1' },
      models: ['anthropic/claude-a'],
      grants: [{ userId: memberId, canUse: true }],
    });
    const r = await resolveByokForModel(
      ownerId,
      'anthropic/claude-a',
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('forbidden');
  });

  it('resolve returns byok payload and redaction list', async () => {
    await seedSecret({
      name: 'a',
      provider: 'anthropic',
      credentials: { apiKey: 'sk-secret-resolve' },
      models: ['anthropic/claude-a'],
      grants: [{ userId: memberId, canUse: true }],
    });
    const r = await resolveByokForModel(
      memberId,
      'anthropic/claude-a',
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.provider).toBe('anthropic');
    expect(r.only).toEqual(['anthropic']);
    expect(r.byok.anthropic[0]).toEqual({ apiKey: 'sk-secret-resolve' });
    expect(r.secretsToRedact).toContain('sk-secret-resolve');
  });

  it('prefer provider matching model prefix, then created_at ASC', async () => {
    const olderOpenAi = await seedSecret({
      name: 'openai-old',
      provider: 'openai',
      credentials: { apiKey: 'openai-key' },
      models: ['anthropic/claude-x'],
      grants: [{ userId: memberId, canUse: true }],
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    const newerAnthropic = await seedSecret({
      name: 'anthropic-new',
      provider: 'anthropic',
      credentials: { apiKey: 'anthropic-key' },
      models: ['anthropic/claude-x'],
      grants: [{ userId: memberId, canUse: true }],
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });

    const r = await resolveByokForModel(
      memberId,
      'anthropic/claude-x',
      deps(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.secretId).toBe(newerAnthropic);
    expect(r.provider).toBe('anthropic');

    // same provider: older wins
    await db.delete(schema.providerSecretGrants);
    await db.delete(schema.providerSecretModels);
    await db.delete(schema.providerSecrets);

    const s1 = await seedSecret({
      name: 'a1',
      provider: 'anthropic',
      credentials: { apiKey: 'first' },
      models: ['anthropic/claude-y'],
      grants: [{ userId: memberId, canUse: true }],
      createdAt: new Date('2021-01-01T00:00:00Z'),
    });
    await seedSecret({
      name: 'a2',
      provider: 'anthropic',
      credentials: { apiKey: 'second' },
      models: ['anthropic/claude-y'],
      grants: [{ userId: memberId, canUse: true }],
      createdAt: new Date('2022-01-01T00:00:00Z'),
    });
    const r2 = await resolveByokForModel(
      memberId,
      'anthropic/claude-y',
      deps(),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error('expected ok');
    expect(r2.secretId).toBe(s1);
    expect(r2.credentials).toEqual({ apiKey: 'first' });
    void olderOpenAi;
  });

  it('disabled secret excluded', async () => {
    await seedSecret({
      name: 'd',
      provider: 'openai',
      credentials: { apiKey: 'k' },
      models: ['openai/gpt-4'],
      grants: [{ userId: memberId, canUse: true }],
      status: 'disabled',
    });
    expect(await listModelsForUser(memberId, deps())).toEqual([]);
    const r = await resolveByokForModel(memberId, 'openai/gpt-4', deps());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('forbidden');
  });

  it('can_use=false excluded', async () => {
    await seedSecret({
      name: 'd',
      provider: 'openai',
      credentials: { apiKey: 'k' },
      models: ['openai/gpt-4'],
      grants: [{ userId: memberId, canUse: false }],
    });
    expect(await listModelsForUser(memberId, deps())).toEqual([]);
    const r = await resolveByokForModel(memberId, 'openai/gpt-4', deps());
    expect(r.ok).toBe(false);
  });

  it('invalid model id', async () => {
    const r = await resolveByokForModel(memberId, 'nope', deps());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('model_invalid');
  });

  it('decrypt failure → unavailable', async () => {
    const id = await seedSecret({
      name: 'badct',
      provider: 'anthropic',
      credentials: { apiKey: 'k' },
      models: ['anthropic/claude-a'],
      grants: [{ userId: memberId, canUse: true }],
    });
    await db
      .update(schema.providerSecrets)
      .set({ credentialCiphertext: 'not-valid-ciphertext' })
      .where(eq(schema.providerSecrets.id, id));

    const r = await resolveByokForModel(
      memberId,
      'anthropic/claude-a',
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.reason).toBe('unavailable');
  });
});
