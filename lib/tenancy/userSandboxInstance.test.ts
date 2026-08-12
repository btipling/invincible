import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  buildUserSandboxVercelName,
  createHttp,
  createWorkspace,
  destroyInstance,
  isNotFoundPlatformError,
  loadInstance,
  reconcileStatus,
  startInstance,
  stopInstance,
  USER_SANDBOX_HTTP_IMAGE,
  USER_SANDBOX_IDLE_TIMEOUT_MS,
  type PlatformSandboxHandle,
  type UserSandboxPlatformApi,
} from './userSandboxInstance';
import { getSharedEngine, resetTenantTables } from './test/shared';
import type { SharedEngine } from './test/shared';

let db!: SharedEngine['db'];
let client!: SharedEngine['client'];
let userId: string;
let tenantId: string;
let catalogVercelId: string;
let catalogByoId: string;

function makeFakeApi(opts?: {
  getImpl?: (name: string) => Promise<PlatformSandboxHandle>;
}): {
  api: UserSandboxPlatformApi;
  creates: Array<{ name: string; image: string; persistent: true; timeout: number; networkPolicy: string }>;
  gets: string[];
  stops: string[];
  deletes: string[];
  extends: Array<{ name: string; ms: number }>;
  getCalls: Array<{ name: string; resume?: boolean }>;
} {
  const creates: Array<{
    name: string;
    image: string;
    persistent: true;
    timeout: number;
    networkPolicy: string;
  }> = [];
  const gets: string[] = [];
  const getCalls: Array<{ name: string; resume?: boolean }> = [];
  const stops: string[] = [];
  const deletes: string[] = [];
  const extendsMs: Array<{ name: string; ms: number }> = [];
  const alive = new Map<string, { status: string }>();

  const handle = (name: string): PlatformSandboxHandle => ({
    name,
    status: alive.get(name)?.status ?? 'running',
    stop: async () => {
      stops.push(name);
      const cur = alive.get(name);
      if (cur) cur.status = 'stopped';
    },
    delete: async () => {
      deletes.push(name);
      alive.delete(name);
    },
    extendTimeout: async (ms) => {
      extendsMs.push({ name, ms });
    },
  });

  const api: UserSandboxPlatformApi = {
    create: async (params) => {
      creates.push({
        name: params.name,
        image: params.image,
        persistent: params.persistent,
        timeout: params.timeout,
        networkPolicy: params.networkPolicy,
      });
      alive.set(params.name, { status: 'running' });
      return handle(params.name);
    },
    get: async (params) => {
      gets.push(params.name);
      getCalls.push({ name: params.name, resume: params.resume });
      if (opts?.getImpl) return opts.getImpl(params.name);
      if (!alive.has(params.name)) {
        const err = new Error(`not_found: ${params.name}`) as Error & {
          response: { status: number };
          code: string;
        };
        err.response = { status: 404 };
        err.code = 'not_found';
        throw err;
      }
      return handle(params.name);
    },
  };

  return { api, creates, gets, stops, deletes, extends: extendsMs, getCalls };
}

describe('userSandboxInstance', () => {
  /** PGlite drizzle is not assignable to postgres Db; cast like other tenancy tests. */
  const depsDb = () => db as never;

  beforeAll(async () => {
    const engine = await getSharedEngine();
    db = engine.db;
    client = engine.client;
  });

  beforeEach(async () => {
    await resetTenantTables();

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

    const [vSb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Vercel WS',
        slug: 'vercel-ws',
        backend: 'vercel',
        image: 'vercel/sandbox/node:24',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    catalogVercelId = vSb.id;

    const [byo] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'BYO',
        slug: 'byo',
        backend: 'byo',
        baseUrl: 'https://example.invalid',
        tokenCiphertext: 'v1:x:y:z',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    catalogByoId = byo.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId: catalogVercelId,
      userId,
      canRead: true,
      canWrite: true,
    });
  });

  it('applies 0008 migration (user_sandbox_instances exists)', async () => {
    const res = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'user_sandbox_instances'
       ORDER BY column_name`,
    );
    const cols = (res.rows as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );
    expect(cols).toContain('user_id');
    expect(cols).toContain('purpose');
    expect(cols).toContain('vercel_name');
    expect(cols).toContain('catalog_sandbox_id');
  });

  it('buildUserSandboxVercelName is stable for tenant+user+purpose', () => {
    const a = buildUserSandboxVercelName('workspace', tenantId, userId);
    const b = buildUserSandboxVercelName('workspace', tenantId, userId);
    const http = buildUserSandboxVercelName('http', tenantId, userId);
    expect(a).toBe(b);
    expect(a).toMatch(/^inv-workspace-[a-f0-9]{32}$/);
    expect(http).toMatch(/^inv-http-[a-f0-9]{32}$/);
    expect(a).not.toBe(http);
    const expected = createHash('sha256')
      .update(`${tenantId}:${userId}`)
      .digest('hex')
      .slice(0, 32);
    expect(a).toBe(`inv-workspace-${expected}`);
  });

  it('createWorkspace once with image from preferred vercel catalog', async () => {
    await db.insert(schema.userPreferredSandbox).values({
      userId,
      tenantId,
      sandboxId: catalogVercelId,
    });
    const fake = makeFakeApi();
    const r = await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.purpose).toBe('workspace');
    expect(r.value.status).toBe('running');
    expect(r.value.image).toBe('vercel/sandbox/node:24');
    expect(r.value.catalogSandboxId).toBe(catalogVercelId);
    expect(r.value.vercelName).toBe(
      buildUserSandboxVercelName('workspace', tenantId, userId),
    );
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]).toMatchObject({
      name: r.value.vercelName,
      image: 'vercel/sandbox/node:24',
      persistent: true,
      timeout: USER_SANDBOX_IDLE_TIMEOUT_MS,
      networkPolicy: 'allow-all',
    });
  });

  it('duplicate createWorkspace fails already_exists', async () => {
    const fake = makeFakeApi();
    const first = await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(first.ok).toBe(true);
    const second = await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('already_exists');
    expect(fake.creates).toHaveLength(1);
  });

  it('createWorkspace rejects byo preferred / no vercel grant', async () => {
    await db.delete(schema.sandboxGrants);
    await db.insert(schema.sandboxGrants).values({
      sandboxId: catalogByoId,
      userId,
      canRead: true,
      canWrite: true,
    });
    await db.insert(schema.userPreferredSandbox).values({
      userId,
      tenantId,
      sandboxId: catalogByoId,
    });
    const fake = makeFakeApi();
    const r = await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('precondition');
    expect(fake.creates).toHaveLength(0);
  });

  it('createWorkspace fails no_membership without tenant', async () => {
    await db.delete(schema.tenantMembers);
    const fake = makeFakeApi();
    const r = await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no_membership');
  });

  it('createHttp once with universal image and null catalog', async () => {
    const fake = makeFakeApi();
    const r = await createHttp(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.purpose).toBe('http');
    expect(r.value.image).toBe(USER_SANDBOX_HTTP_IMAGE);
    expect(r.value.catalogSandboxId).toBeNull();
    expect(r.value.vercelName).toBe(
      buildUserSandboxVercelName('http', tenantId, userId),
    );
    expect(fake.creates[0].image).toBe(USER_SANDBOX_HTTP_IMAGE);
  });

  it('destroy removes row and calls stop+delete', async () => {
    const fake = makeFakeApi();
    const created = await createHttp(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const d = await destroyInstance(userId, 'http', { db: depsDb(), sandboxApi: fake.api });
    expect(d.ok).toBe(true);
    expect(fake.stops).toContain(created.value.vercelName);
    expect(fake.deletes).toContain(created.value.vercelName);
    const load = await loadInstance(userId, 'http', { db: depsDb() });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value).toBeNull();
  });

  it('start not_found → error status and never creates', async () => {
    const fake = makeFakeApi();
    // Seed row without platform VM
    const name = buildUserSandboxVercelName('workspace', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'workspace',
      tenantId,
      catalogSandboxId: catalogVercelId,
      vercelName: name,
      image: 'vercel/sandbox/node:24',
      status: 'stopped',
    });
    const beforeCreates = fake.creates.length;
    const r = await startInstance(userId, 'workspace', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('platform');
    expect(r.error).toMatch(/Destroy and Create/i);
    expect(fake.creates).toHaveLength(beforeCreates);
    const row = await db
      .select()
      .from(schema.userSandboxInstances)
      .where(
        and(
          eq(schema.userSandboxInstances.userId, userId),
          eq(schema.userSandboxInstances.purpose, 'workspace'),
        ),
      );
    expect(row[0]?.status).toBe('error');
    expect(row[0]?.lastError).toMatch(/Destroy and Create/i);
  });

  it('start success → running + extendTimeout best-effort', async () => {
    const fake = makeFakeApi();
    const created = await createHttp(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // mark stopped first
    await db
      .update(schema.userSandboxInstances)
      .set({ status: 'stopped' })
      .where(
        and(
          eq(schema.userSandboxInstances.userId, userId),
          eq(schema.userSandboxInstances.purpose, 'http'),
        ),
      );
    const r = await startInstance(userId, 'http', { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('running');
    expect(fake.extends.some((e) => e.name === created.value.vercelName)).toBe(
      true,
    );
  });

  it('stop → stopped', async () => {
    const fake = makeFakeApi();
    const created = await createHttp(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await stopInstance(userId, 'http', { db: depsDb(), sandboxApi: fake.api });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('stopped');
    expect(fake.stops).toContain(created.value.vercelName);
  });

  it('loadInstance null / found', async () => {
    const empty = await loadInstance(userId, 'workspace', { db: depsDb() });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value).toBeNull();

    const fake = makeFakeApi();
    await createWorkspace(userId, { db: depsDb(), sandboxApi: fake.api });
    const found = await loadInstance(userId, 'workspace', { db: depsDb() });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value?.purpose).toBe('workspace');
  });

  it('create APIs have no vercel_name client parameter (shape)', () => {
    // Compile-time + runtime: only userId (+ deps).
    expect(createWorkspace.length).toBeLessThanOrEqual(2);
    expect(createHttp.length).toBeLessThanOrEqual(2);
  });

  it('isNotFoundPlatformError detects 404 / not_found', () => {
    expect(
      isNotFoundPlatformError({ response: { status: 404 }, message: 'x' }),
    ).toBe(true);
    expect(isNotFoundPlatformError({ code: 'not_found' })).toBe(true);
    expect(isNotFoundPlatformError(new Error('not_found'))).toBe(true);
    expect(isNotFoundPlatformError(new Error('boom'))).toBe(false);
  });

  it('reconcileStatus maps not_found to error without create', async () => {
    const name = buildUserSandboxVercelName('http', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'http',
      tenantId,
      catalogSandboxId: null,
      vercelName: name,
      image: USER_SANDBOX_HTTP_IMAGE,
      status: 'running',
    });
    const fake = makeFakeApi();
    const r = await reconcileStatus(userId, 'http', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('error');
    expect(fake.creates).toHaveLength(0);
  });

  it('reconcileStatus probes with resume:false (does not wake stopped VMs)', async () => {
    const name = buildUserSandboxVercelName('workspace', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'workspace',
      tenantId,
      catalogSandboxId: catalogVercelId,
      vercelName: name,
      image: 'img:test',
      status: 'stopped',
    });
    const fake = makeFakeApi();
    // Seed platform row as stopped so get succeeds without 404.
    await fake.api.create({
      name,
      image: 'img:test',
      persistent: true,
      timeout: 1_800_000,
      networkPolicy: 'allow-all',
    });
    await fake.api.get({ name, resume: true });
    // mark stopped via handle stop after create
    const h = await fake.api.get({ name, resume: false });
    await h.stop();
    const r = await reconcileStatus(userId, 'workspace', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('stopped');
    // Last get from reconcile must be resume:false
    const reconcileGets = fake.getCalls.filter((c) => c.name === name);
    expect(reconcileGets.at(-1)?.resume).toBe(false);
  });

  it('startInstance resumes with resume:true', async () => {
    const name = buildUserSandboxVercelName('http', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'http',
      tenantId,
      catalogSandboxId: null,
      vercelName: name,
      image: USER_SANDBOX_HTTP_IMAGE,
      status: 'stopped',
    });
    const fake = makeFakeApi();
    await fake.api.create({
      name,
      image: USER_SANDBOX_HTTP_IMAGE,
      persistent: true,
      timeout: 1_800_000,
      networkPolicy: 'allow-all',
    });
    const r = await startInstance(userId, 'http', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(r.ok).toBe(true);
    const startGets = fake.getCalls.filter((c) => c.name === name);
    expect(startGets.some((c) => c.resume === true)).toBe(true);
  });

  it('destroy keeps row when get fails non-not_found', async () => {
    const name = buildUserSandboxVercelName('http', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'http',
      tenantId,
      catalogSandboxId: null,
      vercelName: name,
      image: USER_SANDBOX_HTTP_IMAGE,
      status: 'running',
    });
    const fake = makeFakeApi({
      getImpl: async () => {
        throw new Error('upstream 503');
      },
    });
    const d = await destroyInstance(userId, 'http', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe('platform');
    const load = await loadInstance(userId, 'http', { db: depsDb() });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value?.vercelName).toBe(name);
    expect(fake.deletes).toHaveLength(0);
  });

  it('destroy keeps row when delete fails non-not_found', async () => {
    const fake = makeFakeApi({
      getImpl: async (n) => ({
        name: n,
        status: 'running',
        stop: async () => {
          fake.stops.push(n);
        },
        delete: async () => {
          throw new Error('delete denied');
        },
        extendTimeout: async () => {},
      }),
    });
    const created = await createHttp(userId, { db: depsDb(), sandboxApi: fake.api });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // After create, getImpl still overrides get — destroy will hit delete denied
    const d = await destroyInstance(userId, 'http', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe('platform');
    const load = await loadInstance(userId, 'http', { db: depsDb() });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value).not.toBeNull();
  });

  it('create rolls back claim when platform create fails', async () => {
    const failing = makeFakeApi();
    failing.api.create = async () => {
      throw new Error('quota exceeded');
    };
    const r = await createHttp(userId, {
      db: depsDb(),
      sandboxApi: failing.api,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('platform');
    expect(failing.creates).toHaveLength(0);
    const load = await loadInstance(userId, 'http', { db: depsDb() });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value).toBeNull();
  });

  it('destroy not_found still removes row', async () => {
    const name = buildUserSandboxVercelName('workspace', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'workspace',
      tenantId,
      catalogSandboxId: catalogVercelId,
      vercelName: name,
      image: 'vercel/sandbox/node:24',
      status: 'error',
    });
    const fake = makeFakeApi(); // get → not_found (not in alive)
    const d = await destroyInstance(userId, 'workspace', {
      db: depsDb(),
      sandboxApi: fake.api,
    });
    expect(d.ok).toBe(true);
    const load = await loadInstance(userId, 'workspace', { db: depsDb() });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.value).toBeNull();
  });
});
