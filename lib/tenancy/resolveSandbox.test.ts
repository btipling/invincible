import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema';
import { encryptSecret } from './credentials';
import {
  SANDBOX_FORBIDDEN_ERROR,
  WORKSPACE_INSTANCE_REQUIRED_ERROR,
} from './errors';
import { buildUserSandboxVercelName } from './userSandboxInstance';
import { resolveAgentSandbox } from './resolveSandbox';
import {
  decryptSandboxToken,
  encryptTenantSecret,
} from './tenantKeys';
import { getSharedDb, resetTenantTables } from './test/shared';
import type { SharedEngine } from './test/shared';

const AMK = Buffer.alloc(32, 9);

let db!: SharedEngine['db'];


async function insertRunningWorkspace(
  db: SharedEngine['db'],
  opts: { userId: string; tenantId: string; catalogSandboxId: string; image?: string | null },
) {
  const name = buildUserSandboxVercelName('workspace', opts.tenantId, opts.userId);
  await db.insert(schema.userSandboxInstances).values({
    userId: opts.userId,
    purpose: 'workspace',
    tenantId: opts.tenantId,
    catalogSandboxId: opts.catalogSandboxId,
    vercelName: name,
    image: opts.image ?? 'vercel/sandbox/universal:latest',
    status: 'running',
  });
  return name;
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
  let userId: string;
  let tenantId: string;
  let sandboxId: string;

  beforeAll(async () => {
    db = await getSharedDb();
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

    const { ciphertext } = await encryptTenantSecret(
      tenantId,
      'sandbox-token-secret-xyz',
      { db: db as never, amk: AMK },
    );
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

  const decrypt = (tid: string, ct: string) =>
    decryptSandboxToken(tid, ct, { db: db as never, amk: AMK, mode: 'dual' });

  it('resolves single membership + full grant under DEK', async () => {
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createClient: ({ baseUrl, token }) => stubClient({ baseUrl, token }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.sandboxId).toBe(sandboxId);
    expect(result.value.tenantId).toBe(tenantId);
    expect(result.value.permissions).toEqual({ canRead: true, canWrite: true });
    expect(result.value.secrets).toContain('sandbox-token-secret-xyz');
    expect(result.value.baseUrl).toBe('http://127.0.0.1:8787');
    expect(result.value.backend).toBe('byo');
    expect(result.value.resolvedImage).toBeNull();
    expect((result.value.client as { __meta?: { token: string } }).__meta?.token).toBe(
      'sandbox-token-secret-xyz',
    );
  });

  it('dual-read resolves legacy AMK token when DEK missing', async () => {
    await db
      .update(schema.tenants)
      .set({ dekCiphertext: null })
      .where(eq(schema.tenants.id, tenantId));
    await db
      .update(schema.sandboxes)
      .set({ tokenCiphertext: encryptSecret('legacy-amk-token', AMK) })
      .where(eq(schema.sandboxes.id, sandboxId));

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createClient: ({ token }) => stubClient({ baseUrl: '', token }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.secrets).toContain('legacy-amk-token');
  });

  it('dek-only mode fails closed on AMK-only ciphertext', async () => {
    await db
      .update(schema.sandboxes)
      .set({ tokenCiphertext: encryptSecret('legacy-only', AMK) })
      .where(eq(schema.sandboxes.id, sandboxId));

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: (tid, ct) =>
        decryptSandboxToken(tid, ct, {
          db: db as never,
          amk: AMK,
          mode: 'dek-only',
        }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('write-only grant gets effective read', async () => {
    await db
      .update(schema.sandboxGrants)
      .set({ canRead: false, canWrite: true })
      .where(eq(schema.sandboxGrants.userId, userId));

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
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
      decryptSandboxToken: decrypt,
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
      decryptSandboxToken: decrypt,
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
      decryptSandboxToken: decrypt,
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
      decryptSandboxToken: decrypt,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('403 on decrypt failure without leaking crypto detail', async () => {
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: async () => {
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

  it('403 when byo baseUrl or tokenCiphertext null/empty', async () => {
    await db
      .update(schema.sandboxes)
      .set({ baseUrl: null, tokenCiphertext: null, backend: 'byo' })
      .where(eq(schema.sandboxes.id, sandboxId));
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: SANDBOX_FORBIDDEN_ERROR,
    });
  });

  it('403 for empty userId', async () => {
    const result = await resolveAgentSandbox('  ', { db: db as never });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('vercel row + running workspace → attach client by vercelName', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    const name = await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
      image: 'vercel/sandbox/universal:latest',
    });

    const decryptSpy = vi.fn(decrypt);
    const vercelClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: vi.fn(async () => {}),
      __kind: 'vercel',
    };
    const createVercelClient = vi.fn(() => vercelClient as never);

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decryptSpy,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.client).toBe(vercelClient);
    expect(result.value.backend).toBe('vercel');
    expect(result.value.secrets).toEqual([]);
    expect(result.value.baseUrl).toBeUndefined();
    expect(result.value.resolvedImage).toBe('vercel/sandbox/universal:latest');
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(createVercelClient).toHaveBeenCalledWith({
      name,
      image: 'vercel/sandbox/universal:latest',
    });
  });

  it('vercel row without workspace instance → softContinue + WORKSPACE_INSTANCE_REQUIRED', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.softContinue).toBe(true);
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: WORKSPACE_INSTANCE_REQUIRED_ERROR,
    });
    expect(createVercelClient).not.toHaveBeenCalled();
  });

  it('vercel row + stopped workspace → softContinue', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));
    const name = buildUserSandboxVercelName('workspace', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'workspace',
      tenantId,
      catalogSandboxId: sandboxId,
      vercelName: name,
      image: 'vercel/sandbox/universal:latest',
      status: 'stopped',
    });

    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.softContinue).toBe(true);
    expect(createVercelClient).not.toHaveBeenCalled();
  });

  it('vercel row + error workspace → softContinue', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));
    const name = buildUserSandboxVercelName('workspace', tenantId, userId);
    await db.insert(schema.userSandboxInstances).values({
      userId,
      purpose: 'workspace',
      tenantId,
      catalogSandboxId: sandboxId,
      vercelName: name,
      image: 'vercel/sandbox/universal:latest',
      status: 'error',
    });

    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.softContinue).toBe(true);
    expect(createVercelClient).not.toHaveBeenCalled();
  });

  it('vercel instance custom image → factory receives that image + name', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: 'vercel/sandbox/node:24',
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    const name = await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
      image: 'vercel/sandbox/node:24',
    });

    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(createVercelClient).toHaveBeenCalledWith({
      name,
      image: 'vercel/sandbox/node:24',
    });
    expect(result.value.resolvedImage).toBe('vercel/sandbox/node:24');
  });

  it('threads execEnv into vercel and byo client factories', async () => {
    const execEnv = { GH_TOKEN: 'ghp_thread', GITHUB_TOKEN: 'ghp_thread' };

    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    const name = await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
    });

    const createVercelClient = vi.fn(() => stubClient() as never);
    let result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
      execEnv,
    });
    expect(result.ok).toBe(true);
    expect(createVercelClient).toHaveBeenCalledWith({
      name,
      image: 'vercel/sandbox/universal:latest',
      execEnv,
    });

    // Restore byo row with ciphertext (re-encrypt for this test)
    const { ciphertext } = await encryptTenantSecret(
      tenantId,
      'sandbox-token-secret-xyz',
      { db: db as never, amk: AMK },
    );
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'byo',
        baseUrl: 'http://127.0.0.1:8787/',
        tokenCiphertext: ciphertext,
        image: null,
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    const createByoClient = vi.fn(
      (opts: { baseUrl: string; token: string; execEnv?: Record<string, string> }) =>
        stubClient({ baseUrl: opts.baseUrl, token: opts.token }),
    );
    result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createByoClient,
      execEnv,
    });
    expect(result.ok).toBe(true);
    expect(createByoClient).toHaveBeenCalledWith(
      expect.objectContaining({
        execEnv,
        token: 'sandbox-token-secret-xyz',
      }),
    );
  });

  it('vercel row with stale URL/token still succeeds without decrypt when instance running', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: 'http://stale.example',
        tokenCiphertext: 'stale-ct',
        image: 'vercel/sandbox/universal:latest',
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
      image: 'vercel/sandbox/universal:latest',
    });

    const decryptSpy = vi.fn(async () => {
      throw new Error('should not decrypt');
    });
    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decryptSpy,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(result.value.secrets).toEqual([]);
    expect(result.value.baseUrl).toBeUndefined();
  });

  it('BYO without workspace instance still succeeds', async () => {
    // default beforeEach is byo with token — no instance row.
    // Phase-2 DI (#439): the BYO client factory is injected (the root binds it in prod).
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createByoClient: ({ baseUrl, token }) => stubClient({ baseUrl, token }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.backend).toBe('byo');
  });


  it('multiple usable without preference → selection required error', async () => {
    const [sb2] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'second',
        slug: 'second',
        backend: 'vercel',
        image: null,
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    await db.insert(schema.sandboxGrants).values({
      sandboxId: sb2.id,
      userId,
      canRead: true,
      canWrite: true,
    });

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createVercelClient: () => stubClient() as never,
      createByoClient: () => stubClient() as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toMatch(/Settings → Sandbox|Multiple sandboxes/i);
  });

  it('multiple usable with preference → preferred row', async () => {
    const [sb2] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'second',
        slug: 'second',
        backend: 'vercel',
        image: 'vercel/sandbox/node:24',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    await db.insert(schema.sandboxGrants).values({
      sandboxId: sb2.id,
      userId,
      canRead: true,
      canWrite: true,
    });
    await db.insert(schema.userPreferredSandbox).values({
      userId,
      tenantId,
      sandboxId: sb2.id,
    });

    const createVercelClient = vi.fn(() => stubClient() as never);
    // Prefer sb2 (vercel). Default fixture sandbox is byo — ensure preference wins.
    await db
      .update(schema.sandboxes)
      .set({ backend: 'byo' })
      .where(eq(schema.sandboxes.id, sandboxId));

    const name = await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sb2.id,
      image: 'vercel/sandbox/node:24',
    });

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.sandboxId).toBe(sb2.id);
    expect(result.value.backend).toBe('vercel');
    expect(createVercelClient).toHaveBeenCalledWith({
      name,
      image: 'vercel/sandbox/node:24',
    });
  });

  it('unknown backend string → 403', async () => {
    await db
      .update(schema.sandboxes)
      .set({ backend: 'other' })
      .where(eq(schema.sandboxes.id, sandboxId));
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
  });

  it('vercel invalid instance image shape → 403 without leaking detail', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: 'vercel/sandbox/universal:latest',
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
      image: 'bad image with spaces',
    });

    const createVercelClient = vi.fn(() => {
      throw new Error('should not reach factory for invalid shape');
    });
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe(SANDBOX_FORBIDDEN_ERROR);
    expect(JSON.stringify(body)).not.toContain('spaces');
    // Shape fails before factory — inject must not run.
    expect(createVercelClient).not.toHaveBeenCalled();
  });

  it('vercel factory throw with valid image → 403 without leaking detail', async () => {
    await db
      .update(schema.sandboxes)
      .set({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
        image: 'vercel/sandbox/universal:latest',
      })
      .where(eq(schema.sandboxes.id, sandboxId));

    await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
      image: 'vercel/sandbox/universal:latest',
    });

    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient: () => {
        throw new Error('invalid image secret-detail');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.response.status).toBe(403);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toBe(SANDBOX_FORBIDDEN_ERROR);
    expect(JSON.stringify(body)).not.toContain('secret-detail');
  });

  it('byo resolve carries workspaceRoot from the client accessor', async () => {
    const client = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      workspaceRoot: async () => '/w',
      __meta: { baseUrl: 'http://127.0.0.1:8787', token: 'x' },
    };
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createByoClient: () => client as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.backend).toBe('byo');
    expect(result.value.workspaceRoot).toBe('/w');
  });

  it('vercel resolve carries workspaceRoot from the client accessor', async () => {
    await db
      .update(schema.sandboxes)
      .set({ backend: 'vercel', baseUrl: null, tokenCiphertext: null, image: null })
      .where(eq(schema.sandboxes.id, sandboxId));
    await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
    });
    const vercelClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      workspaceRoot: async () => '/vercel/workspace',
      __kind: 'vercel',
    };
    const createVercelClient = vi.fn(() => vercelClient as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.backend).toBe('vercel');
    expect(result.value.workspaceRoot).toBe('/vercel/workspace');
  });

  it('byo down-daemon resolve: workspaceRoot() throws → resolve still ok with null (never a mislabeled 403)', async () => {
    const client = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      workspaceRoot: async () => {
        throw new Error('daemon unreachable');
      },
      __meta: { baseUrl: 'http://127.0.0.1:8787', token: 'x' },
    };
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      decryptSandboxToken: decrypt,
      createByoClient: () => client as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.backend).toBe('byo');
    expect(result.value.workspaceRoot).toBeNull();
  });

  it('vercel resolve without a workspaceRoot method → null, not a hard 403', async () => {
    await db
      .update(schema.sandboxes)
      .set({ backend: 'vercel', baseUrl: null, tokenCiphertext: null, image: null })
      .where(eq(schema.sandboxes.id, sandboxId));
    await insertRunningWorkspace(db, {
      userId,
      tenantId,
      catalogSandboxId: sandboxId,
    });
    const createVercelClient = vi.fn(() => stubClient() as never);
    const result = await resolveAgentSandbox(userId, {
      db: db as never,
      createVercelClient,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.workspaceRoot).toBeNull();
  });
});
