/**
 * Per-user durable Vercel Sandbox instance lifecycle (parent #298 / phase 1 #299).
 * Server-only domain: Create / Start / Stop / Destroy / load / reconcile.
 * Agent and hop-B must not call Sandbox.create — only this module (and later orphan GHA).
 * Never call Sandbox.getOrCreate.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxGrants,
  sandboxes,
  userPreferredSandbox,
  userSandboxInstances,
  type Db,
  type UserSandboxInstance,
} from '../../db';
import { isUsableGrant } from './grants';
import {
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  resolveVercelSandboxImage,
} from './sandboxBackend';
import { loadSoleMembership } from './soleMembership';

/** Idle auto-stop / extendTimeout duration — 30 minutes (parent lock). */
export const USER_SANDBOX_IDLE_TIMEOUT_MS = 1_800_000;

export const USER_SANDBOX_PURPOSES = ['workspace', 'http'] as const;
export type UserSandboxPurpose = (typeof USER_SANDBOX_PURPOSES)[number];

export const USER_SANDBOX_STATUSES = ['running', 'stopped', 'error'] as const;
export type UserSandboxStatus = (typeof USER_SANDBOX_STATUSES)[number];

/** HTTP/curl instance image (parent lock). */
export const USER_SANDBOX_HTTP_IMAGE = DEFAULT_VERCEL_SANDBOX_IMAGE;

export type UserSandboxInstanceErrorCode =
  | 'no_membership'
  | 'not_found'
  | 'already_exists'
  | 'precondition'
  | 'platform'
  | 'unavailable'
  | 'invalid';

export type UserSandboxInstanceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserSandboxInstanceErrorCode; error: string };

/** Injected platform handle (wraps @vercel/sandbox Sandbox instance). */
export type PlatformSandboxHandle = {
  name: string;
  status?: string;
  stop(opts?: { signal?: AbortSignal }): Promise<void>;
  delete(opts?: { signal?: AbortSignal }): Promise<void>;
  extendTimeout(durationMs: number, opts?: { signal?: AbortSignal }): Promise<void>;
};

export type PlatformCreateParams = {
  name: string;
  image: string;
  persistent: true;
  timeout: number;
  networkPolicy: 'allow-all';
  signal?: AbortSignal;
};

export type PlatformGetParams = {
  name: string;
  resume?: boolean;
  signal?: AbortSignal;
};

/**
 * Injectable Sandbox control-plane surface.
 * Product default loads @vercel/sandbox; tests pass fakes.
 * **Must not** expose getOrCreate.
 */
export type UserSandboxPlatformApi = {
  create(params: PlatformCreateParams): Promise<PlatformSandboxHandle>;
  get(params: PlatformGetParams): Promise<PlatformSandboxHandle>;
};

export type UserSandboxInstanceDeps = {
  db?: Db;
  sandboxApi?: UserSandboxPlatformApi;
  /** Override idle timeout (tests). */
  idleTimeoutMs?: number;
};

function isPurpose(value: string): value is UserSandboxPurpose {
  return (USER_SANDBOX_PURPOSES as readonly string[]).includes(value);
}

/**
 * Stable server-generated Vercel sandbox name.
 * `inv-{purpose}-{sha256(tenantId:userId).hex.slice(0,32)}`
 */
export function buildUserSandboxVercelName(
  purpose: UserSandboxPurpose,
  tenantId: string,
  userId: string,
): string {
  const hash = createHash('sha256')
    .update(`${tenantId}:${userId}`)
    .digest('hex')
    .slice(0, 32);
  return `inv-${purpose}-${hash}`;
}

export function isNotFoundPlatformError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    response?: { status?: number };
    code?: string;
    message?: string;
    json?: { error?: { code?: string } };
  };
  if (e.response?.status === 404) return true;
  if (e.code === 'not_found') return true;
  if (e.json?.error?.code === 'not_found') return true;
  if (/not[_ ]found/i.test(e.message ?? '')) return true;
  return false;
}

function mapPlatformStatus(status: string | undefined): UserSandboxStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'running' || s === 'pending' || s === 'snapshotting') return 'running';
  if (s === 'stopped' || s === 'stopping') return 'stopped';
  if (s === 'failed' || s === 'aborted') return 'error';
  // Unknown / missing → treat as running when get succeeded (session resumed).
  return 'running';
}

async function withDb<T>(
  deps: UserSandboxInstanceDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) return fn(deps.db);
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required');
  }
  const { db, client } = createDbConnection();
  try {
    return await fn(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function defaultPlatformApi(): Promise<UserSandboxPlatformApi> {
  const { Sandbox } = await import('@vercel/sandbox');
  const wrap = (sb: {
    name: string;
    status?: string;
    stop: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
    delete: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
    extendTimeout: (duration: number, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  }): PlatformSandboxHandle => ({
    name: sb.name,
    status: sb.status,
    stop: async (opts) => {
      await sb.stop(opts);
    },
    delete: async (opts) => {
      await sb.delete(opts);
    },
    extendTimeout: async (durationMs, opts) => {
      await sb.extendTimeout(durationMs, opts);
    },
  });

  return {
    async create(params) {
      const sb = await Sandbox.create({
        name: params.name,
        image: params.image,
        persistent: true,
        timeout: params.timeout,
        networkPolicy: params.networkPolicy,
        signal: params.signal,
      });
      return wrap(sb as unknown as Parameters<typeof wrap>[0]);
    },
    async get(params) {
      const sb = await Sandbox.get({
        name: params.name,
        resume: params.resume ?? true,
        signal: params.signal,
      });
      return wrap(sb as unknown as Parameters<typeof wrap>[0]);
    },
  };
}

async function resolveApi(
  deps: UserSandboxInstanceDeps,
): Promise<UserSandboxPlatformApi> {
  return deps.sandboxApi ?? (await defaultPlatformApi());
}

function idleMs(deps: UserSandboxInstanceDeps): number {
  return deps.idleTimeoutMs ?? USER_SANDBOX_IDLE_TIMEOUT_MS;
}

async function loadRow(
  db: Db,
  userId: string,
  purpose: UserSandboxPurpose,
): Promise<UserSandboxInstance | null> {
  const rows = await db
    .select()
    .from(userSandboxInstances)
    .where(
      and(
        eq(userSandboxInstances.userId, userId),
        eq(userSandboxInstances.purpose, purpose),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Select catalog sandbox for workspace Create: preferred if usable vercel,
 * else sole usable vercel grant. Fail precondition otherwise.
 */
async function resolveWorkspaceCatalog(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<
  UserSandboxInstanceResult<{ catalogSandboxId: string; image: string }>
> {
  const grantRows = await db
    .select({
      sandboxId: sandboxes.id,
      backend: sandboxes.backend,
      image: sandboxes.image,
      status: sandboxes.status,
      canRead: sandboxGrants.canRead,
      canWrite: sandboxGrants.canWrite,
    })
    .from(sandboxGrants)
    .innerJoin(sandboxes, eq(sandboxGrants.sandboxId, sandboxes.id))
    .where(
      and(eq(sandboxGrants.userId, userId), eq(sandboxes.tenantId, tenantId)),
    );

  const usableVercel = grantRows.filter(
    (r) =>
      (r.backend ?? '').trim() === 'vercel' &&
      isUsableGrant(r.status, { canRead: r.canRead, canWrite: r.canWrite }),
  );

  if (usableVercel.length === 0) {
    return {
      ok: false,
      code: 'precondition',
      error:
        'workspace Create requires a usable vercel catalog sandbox grant',
    };
  }

  let chosen = usableVercel[0];
  if (usableVercel.length > 1) {
    const pref = await db
      .select({ sandboxId: userPreferredSandbox.sandboxId })
      .from(userPreferredSandbox)
      .where(eq(userPreferredSandbox.userId, userId))
      .limit(1);
    const preferredId = pref[0]?.sandboxId;
    const match = preferredId
      ? usableVercel.find((r) => r.sandboxId === preferredId)
      : undefined;
    if (!match) {
      return {
        ok: false,
        code: 'precondition',
        error:
          'multiple vercel grants — set preferred sandbox in Settings before Create',
      };
    }
    chosen = match;
  }

  const resolved = resolveVercelSandboxImage(chosen.image);
  if (!resolved.ok) {
    return { ok: false, code: 'precondition', error: resolved.error };
  }

  return {
    ok: true,
    value: { catalogSandboxId: chosen.sandboxId, image: resolved.image },
  };
}

async function insertRunning(
  db: Db,
  row: {
    userId: string;
    purpose: UserSandboxPurpose;
    tenantId: string;
    catalogSandboxId: string | null;
    vercelName: string;
    image: string;
  },
): Promise<UserSandboxInstance> {
  const now = new Date();
  const [inserted] = await db
    .insert(userSandboxInstances)
    .values({
      userId: row.userId,
      purpose: row.purpose,
      tenantId: row.tenantId,
      catalogSandboxId: row.catalogSandboxId,
      vercelName: row.vercelName,
      image: row.image,
      status: 'running',
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted;
}

/**
 * Create durable Workspace instance. Name is server-generated — no client name param.
 */
export async function createWorkspace(
  userId: string,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }

  try {
    const membership = await loadSoleMembership(uid, { db: deps.db });
    if (!membership.ok) {
      if (membership.reason === 'db') {
        return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
      }
      return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
    }

    return await withDb(deps, async (db) => {
      const existing = await loadRow(db, uid, 'workspace');
      if (existing) {
        return {
          ok: false,
          code: 'already_exists',
          error: 'workspace instance already exists',
        };
      }

      const catalog = await resolveWorkspaceCatalog(db, uid, membership.tenantId);
      if (!catalog.ok) return catalog;

      const vercelName = buildUserSandboxVercelName(
        'workspace',
        membership.tenantId,
        uid,
      );
      const api = await resolveApi(deps);
      try {
        await api.create({
          name: vercelName,
          image: catalog.value.image,
          persistent: true,
          timeout: idleMs(deps),
          networkPolicy: 'allow-all',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sandbox.create failed';
        return { ok: false, code: 'platform', error: msg.slice(0, 500) };
      }

      const row = await insertRunning(db, {
        userId: uid,
        purpose: 'workspace',
        tenantId: membership.tenantId,
        catalogSandboxId: catalog.value.catalogSandboxId,
        vercelName,
        image: catalog.value.image,
      });
      return { ok: true, value: row };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'createWorkspace failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Create durable HTTP/curl instance. Name is server-generated — no client name param.
 */
export async function createHttp(
  userId: string,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }

  try {
    const membership = await loadSoleMembership(uid, { db: deps.db });
    if (!membership.ok) {
      if (membership.reason === 'db') {
        return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
      }
      return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
    }

    return await withDb(deps, async (db) => {
      const existing = await loadRow(db, uid, 'http');
      if (existing) {
        return {
          ok: false,
          code: 'already_exists',
          error: 'http instance already exists',
        };
      }

      const vercelName = buildUserSandboxVercelName(
        'http',
        membership.tenantId,
        uid,
      );
      const image = USER_SANDBOX_HTTP_IMAGE;
      const api = await resolveApi(deps);
      try {
        await api.create({
          name: vercelName,
          image,
          persistent: true,
          timeout: idleMs(deps),
          networkPolicy: 'allow-all',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sandbox.create failed';
        return { ok: false, code: 'platform', error: msg.slice(0, 500) };
      }

      const row = await insertRunning(db, {
        userId: uid,
        purpose: 'http',
        tenantId: membership.tenantId,
        catalogSandboxId: null,
        vercelName,
        image,
      });
      return { ok: true, value: row };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'createHttp failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Start = get + resume only. Never create / getOrCreate.
 * not_found → status error + guidance to Destroy+Create.
 */
export async function startInstance(
  userId: string,
  purpose: UserSandboxPurpose,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }
  if (!isPurpose(purpose)) {
    return { ok: false, code: 'invalid', error: 'invalid purpose' };
  }

  try {
    return await withDb(deps, async (db) => {
      const row = await loadRow(db, uid, purpose);
      if (!row) {
        return { ok: false, code: 'not_found', error: 'instance not found' };
      }

      const api = await resolveApi(deps);
      try {
        const sb = await api.get({ name: row.vercelName, resume: true });
        try {
          await sb.extendTimeout(idleMs(deps));
        } catch {
          // best-effort
        }
        const [updated] = await db
          .update(userSandboxInstances)
          .set({
            status: mapPlatformStatus(sb.status),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(userSandboxInstances.userId, uid),
              eq(userSandboxInstances.purpose, purpose),
            ),
          )
          .returning();
        return { ok: true, value: updated };
      } catch (err) {
        if (isNotFoundPlatformError(err)) {
          const msg =
            'Sandbox not found on platform — Destroy and Create again';
          const [updated] = await db
            .update(userSandboxInstances)
            .set({
              status: 'error',
              lastError: msg,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userSandboxInstances.userId, uid),
                eq(userSandboxInstances.purpose, purpose),
              ),
            )
            .returning();
          return { ok: false, code: 'platform', error: msg };
        }
        const msg = err instanceof Error ? err.message : 'Sandbox.get failed';
        return { ok: false, code: 'platform', error: msg.slice(0, 500) };
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'startInstance failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Stop platform VM and mark stopped.
 */
export async function stopInstance(
  userId: string,
  purpose: UserSandboxPurpose,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }
  if (!isPurpose(purpose)) {
    return { ok: false, code: 'invalid', error: 'invalid purpose' };
  }

  try {
    return await withDb(deps, async (db) => {
      const row = await loadRow(db, uid, purpose);
      if (!row) {
        return { ok: false, code: 'not_found', error: 'instance not found' };
      }

      const api = await resolveApi(deps);
      try {
        const sb = await api.get({ name: row.vercelName, resume: true });
        await sb.stop();
      } catch (err) {
        if (!isNotFoundPlatformError(err)) {
          const msg = err instanceof Error ? err.message : 'Sandbox.stop failed';
          return { ok: false, code: 'platform', error: msg.slice(0, 500) };
        }
        // not_found: still mark stopped in DB
      }

      const [updated] = await db
        .update(userSandboxInstances)
        .set({
          status: 'stopped',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userSandboxInstances.userId, uid),
            eq(userSandboxInstances.purpose, purpose),
          ),
        )
        .returning();
      return { ok: true, value: updated };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'stopInstance failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Destroy = stop (ignore) + delete (ignore not_found) + DELETE row.
 */
export async function destroyInstance(
  userId: string,
  purpose: UserSandboxPurpose,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<{ destroyed: true }>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }
  if (!isPurpose(purpose)) {
    return { ok: false, code: 'invalid', error: 'invalid purpose' };
  }

  try {
    return await withDb(deps, async (db) => {
      const row = await loadRow(db, uid, purpose);
      if (!row) {
        return { ok: false, code: 'not_found', error: 'instance not found' };
      }

      const api = await resolveApi(deps);
      try {
        const sb = await api.get({ name: row.vercelName, resume: true });
        try {
          await sb.stop();
        } catch {
          // ignore stop errors
        }
        try {
          await sb.delete();
        } catch {
          // ignore delete errors
        }
      } catch {
        // get failed (including not_found) — still remove row
      }

      await db
        .delete(userSandboxInstances)
        .where(
          and(
            eq(userSandboxInstances.userId, uid),
            eq(userSandboxInstances.purpose, purpose),
          ),
        );
      return { ok: true, value: { destroyed: true } };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'destroyInstance failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Load registry row for later phases (resolve / agent attach).
 */
export async function loadInstance(
  userId: string,
  purpose: UserSandboxPurpose,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance | null>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }
  if (!isPurpose(purpose)) {
    return { ok: false, code: 'invalid', error: 'invalid purpose' };
  }

  try {
    return await withDb(deps, async (db) => {
      const row = await loadRow(db, uid, purpose);
      return { ok: true, value: row };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'loadInstance failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}

/**
 * Probe platform and reconcile DB status (Settings load / Start support).
 */
export async function reconcileStatus(
  userId: string,
  purpose: UserSandboxPurpose,
  deps: UserSandboxInstanceDeps = {},
): Promise<UserSandboxInstanceResult<UserSandboxInstance>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'invalid', error: 'userId is required' };
  }
  if (!isPurpose(purpose)) {
    return { ok: false, code: 'invalid', error: 'invalid purpose' };
  }

  try {
    return await withDb(deps, async (db) => {
      const row = await loadRow(db, uid, purpose);
      if (!row) {
        return { ok: false, code: 'not_found', error: 'instance not found' };
      }

      const api = await resolveApi(deps);
      try {
        const sb = await api.get({ name: row.vercelName, resume: true });
        const status = mapPlatformStatus(sb.status);
        const [updated] = await db
          .update(userSandboxInstances)
          .set({
            status,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(userSandboxInstances.userId, uid),
              eq(userSandboxInstances.purpose, purpose),
            ),
          )
          .returning();
        return { ok: true, value: updated };
      } catch (err) {
        if (isNotFoundPlatformError(err)) {
          const msg =
            'Sandbox not found on platform — Destroy and Create again';
          const [updated] = await db
            .update(userSandboxInstances)
            .set({
              status: 'error',
              lastError: msg,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userSandboxInstances.userId, uid),
                eq(userSandboxInstances.purpose, purpose),
              ),
            )
            .returning();
          return { ok: true, value: updated };
        }
        const msg = err instanceof Error ? err.message : 'Sandbox.get failed';
        return { ok: false, code: 'platform', error: msg.slice(0, 500) };
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'reconcileStatus failed';
    return { ok: false, code: 'unavailable', error: msg.slice(0, 500) };
  }
}
