/**
 * Per-user MCP server CRUD under tenant DEK (parent #116 / phase #117–#118).
 * Server-only. Never log plaintext keys or ciphertext.
 * tenantId is always derived from loadSoleMembership — never client input.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  userMcpServers,
  type Db,
} from '../../db';
import {
  MAX_MCP_SERVERS_PER_USER,
  MCP_HEADER_NAME_MAX,
  MCP_HEADER_NAME_RE,
  MCP_LAST_ERROR_MAX,
  MCP_NAME_MAX,
  MCP_NAME_MIN,
  MCP_SLUG_RE,
} from '../mcp/limits';
import { assertSafeMcpUrl } from '../mcp/urlPolicy';
import { maskSecret } from './maskSecret';
import { loadSoleMembership } from './soleMembership';
import {
  decryptTenantSecret,
  encryptTenantSecret,
  ensureTenantDek,
  type TenantKeyDeps,
} from './tenantKeys';

export type UserMcpServersDeps = TenantKeyDeps & {
  db?: Db;
};

export type UserMcpServerErrorCode =
  | 'invalid_name'
  | 'invalid_slug'
  | 'invalid_url'
  | 'invalid_header'
  | 'duplicate_name'
  | 'duplicate_slug'
  | 'limit_exceeded'
  | 'not_found'
  | 'no_membership'
  | 'unavailable';

export type UserMcpServerResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserMcpServerErrorCode; error: string };

export type UserMcpServerListItem = {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  slug: string;
  url: string;
  transport: string;
  authHeaderName: string | null;
  authMode: string;
  enabled: boolean;
  hasApiKey: boolean;
  /** maskSecret last-4 when key present; null when no key */
  apiKeyMask: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Runtime decrypt shape for phase 2 (server-only). */
export type UserMcpSecretRow = {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  slug: string;
  url: string;
  transport: string;
  authHeaderName: string | null;
  authMode: string;
  /** Raw API key or null when auth_mode=none */
  apiKey: string | null;
  enabled: boolean;
  lastError: string | null;
};

async function withDb<T>(
  deps: UserMcpServersDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) {
    return fn(deps.db);
  }
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

function isUniqueViolation(err: unknown): boolean {
  const walk = (e: unknown, depth = 0): boolean => {
    if (!e || depth > 4) return false;
    const x = e as { code?: string; message?: string; cause?: unknown; constraint?: string };
    if (x.code === '23505') return true;
    if (/unique|duplicate key/i.test(x.message ?? '')) return true;
    return walk(x.cause, depth + 1);
  };
  return walk(err);
}

function isUndefinedTable(err: unknown): boolean {
  const walk = (e: unknown, depth = 0): boolean => {
    if (!e || depth > 4) return false;
    const x = e as { code?: string; message?: string; cause?: unknown };
    if (x.code === '42P01') return true;
    if (/relation .* does not exist|undefined_table/i.test(x.message ?? '')) {
      return true;
    }
    return walk(x.cause, depth + 1);
  };
  return walk(err);
}

function trimName(name: string): string | null {
  const n = name?.trim() ?? '';
  if (n.length < MCP_NAME_MIN || n.length > MCP_NAME_MAX) return null;
  return n;
}

function trimSlug(slug: string): string | null {
  const s = slug?.trim() ?? '';
  if (!MCP_SLUG_RE.test(s)) return null;
  return s;
}

function normalizeHeaderName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const h = name.trim();
  if (!h) return null;
  return h;
}

function validateHeaderName(name: string): boolean {
  return (
    MCP_HEADER_NAME_RE.test(name) &&
    name.length >= 1 &&
    name.length <= MCP_HEADER_NAME_MAX
  );
}

async function resolveTenantId(
  userId: string,
  deps: UserMcpServersDeps,
): Promise<UserMcpServerResult<string>> {
  const membership = await loadSoleMembership(userId, { db: deps.db });
  if (!membership.ok) {
    if (membership.reason === 'db') {
      return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
    }
    return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
  }
  return { ok: true, value: membership.tenantId };
}

function uniqueCodeFromError(err: unknown): UserMcpServerErrorCode {
  const collect = (e: unknown, depth = 0): string => {
    if (!e || depth > 4) return '';
    const x = e as {
      message?: string;
      constraint?: string;
      detail?: string;
      cause?: unknown;
    };
    return [
      x.constraint ?? '',
      x.message ?? '',
      x.detail ?? '',
      collect(x.cause, depth + 1),
    ].join(' ');
  };
  const msg = collect(err);
  // Prefer explicit constraint names (both contain "user_id").
  if (/user_id_slug_unique|slug_unique|\(slug\)/i.test(msg)) {
    return 'duplicate_slug';
  }
  if (/user_id_name_unique|name_unique|\(name\)/i.test(msg)) {
    return 'duplicate_name';
  }
  // PGlite may only surface generic unique text — last resort.
  if (/\bslug\b/i.test(msg) && !/\bname\b/i.test(msg)) {
    return 'duplicate_slug';
  }
  return 'duplicate_name';
}


function truncateLastError(msg: string | null): string | null {
  if (msg == null) return null;
  const t = msg.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MCP_LAST_ERROR_MAX ? t.slice(0, MCP_LAST_ERROR_MAX) : t;
}

export type CreateUserMcpServerInput = {
  userId: string;
  name: string;
  slug: string;
  url: string;
  authHeaderName?: string | null;
  /** Raw API key; empty/omitted ⇒ auth_mode=none */
  apiKey?: string | null;
};

export async function createUserMcpServer(
  input: CreateUserMcpServerInput,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<{ id: string }>> {
  const userId = input.userId?.trim();
  if (!userId) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }
  const name = trimName(input.name);
  if (!name) {
    return {
      ok: false,
      code: 'invalid_name',
      error: `name must be ${MCP_NAME_MIN}–${MCP_NAME_MAX} chars`,
    };
  }
  const slug = trimSlug(input.slug);
  if (!slug) {
    return {
      ok: false,
      code: 'invalid_slug',
      error: 'slug must match ^[a-z][a-z0-9_]{0,31}$',
    };
  }
  const urlCheck = await assertSafeMcpUrl(input.url);
  if (!urlCheck.ok) {
    return { ok: false, code: 'invalid_url', error: urlCheck.error };
  }

  const rawKey = input.apiKey?.trim() ?? '';
  const hasKey = rawKey.length > 0;
  let authHeaderName: string | null = null;
  let authMode: 'api_key' | 'none' = 'none';

  if (hasKey) {
    const header = normalizeHeaderName(input.authHeaderName);
    if (!header || !validateHeaderName(header)) {
      return {
        ok: false,
        code: 'invalid_header',
        error: 'auth header name required when API key is set (A-Za-z0-9-, ≤64)',
      };
    }
    authHeaderName = header;
    authMode = 'api_key';
  }

  try {
    const tid = await resolveTenantId(userId, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      // Single txn: lock tenant DEK (via encrypt) + user MCP rows before insert
      // so concurrent rotate/create cannot strand ciphertext under a discarded DEK,
      // and concurrent creates cannot exceed MAX_MCP_SERVERS_PER_USER.
      return await db.transaction(async (tx) => {
        // Lock order matches rotateTenantDek: tenant row first, then MCP rows.
        const dek = await ensureTenantDek(tid.value, { ...deps, db, tx });

        const existingRows = await tx
          .select({ id: userMcpServers.id })
          .from(userMcpServers)
          .where(eq(userMcpServers.userId, userId))
          .for('update');
        if (existingRows.length >= MAX_MCP_SERVERS_PER_USER) {
          return {
            ok: false as const,
            code: 'limit_exceeded' as const,
            error: `at most ${MAX_MCP_SERVERS_PER_USER} MCP servers per user`,
          };
        }

        let ciphertext: string | null = null;
        let kekVersion: number | null = null;
        if (hasKey) {
          const enc = await encryptTenantSecret(tid.value, rawKey, {
            ...deps,
            db,
            tx,
          });
          ciphertext = enc.ciphertext;
          kekVersion = enc.dekVersion;
          // dek.version should match enc.dekVersion under the same lock
          if (enc.dekVersion !== dek.version) {
            throw new Error('DEK version changed under lock');
          }
        }

        try {
          const [row] = await tx
            .insert(userMcpServers)
            .values({
              tenantId: tid.value,
              userId,
              name,
              slug,
              url: urlCheck.href,
              transport: 'http',
              authHeaderName,
              authHeaderValueCiphertext: ciphertext,
              authHeaderKekVersion: kekVersion,
              authMode,
              enabled: true,
            })
            .returning({ id: userMcpServers.id });
          return { ok: true as const, value: { id: row.id } };
        } catch (err) {
          if (isUniqueViolation(err)) {
            const code = uniqueCodeFromError(err);
            return {
              ok: false as const,
              code,
              error:
                code === 'duplicate_slug'
                  ? 'slug already exists for user'
                  : 'name already exists for user',
            };
          }
          throw err;
        }
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not create MCP server' };
  }
}

export type UpdateUserMcpServerInput = {
  userId: string;
  id: string;
  name?: string;
  slug?: string;
  url?: string;
  authHeaderName?: string | null;
  /**
   * Non-empty → re-encrypt new key.
   * Empty/omitted → keep existing ciphertext (no clear-key in v1).
   */
  apiKey?: string | null;
  enabled?: boolean;
};

export async function updateUserMcpServer(
  input: UpdateUserMcpServerInput,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<{ id: string }>> {
  const userId = input.userId?.trim();
  const id = input.id?.trim();
  if (!userId || !id) {
    return { ok: false, code: 'not_found', error: 'MCP server not found' };
  }

  try {
    // Resolve membership tenant first so we can lock tenant → MCP (rotate order).
    const tid = await resolveTenantId(userId, deps);
    if (!tid.ok) {
      // Preserve prior not_found masking for empty ids; membership errors surface.
      if (tid.code === 'no_membership' || tid.code === 'unavailable') {
        return tid;
      }
      return tid;
    }

    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        await ensureTenantDek(tid.value, { ...deps, db, tx });

        const existing = await tx
          .select()
          .from(userMcpServers)
          .where(
            and(eq(userMcpServers.id, id), eq(userMcpServers.userId, userId)),
          )
          .for('update')
          .limit(1);
        const row = existing[0];
        if (!row) {
          return {
            ok: false as const,
            code: 'not_found' as const,
            error: 'MCP server not found',
          };
        }
        if (row.tenantId !== tid.value) {
          return {
            ok: false as const,
            code: 'not_found' as const,
            error: 'MCP server not found',
          };
        }

        const patch: {
          name?: string;
          slug?: string;
          url?: string;
          authHeaderName?: string | null;
          authHeaderValueCiphertext?: string | null;
          authHeaderKekVersion?: number | null;
          authMode?: string;
          enabled?: boolean;
          updatedAt: Date;
        } = { updatedAt: new Date() };

        if (input.name !== undefined) {
          const name = trimName(input.name);
          if (!name) {
            return {
              ok: false as const,
              code: 'invalid_name' as const,
              error: `name must be ${MCP_NAME_MIN}–${MCP_NAME_MAX} chars`,
            };
          }
          patch.name = name;
        }

        if (input.slug !== undefined) {
          const slug = trimSlug(input.slug);
          if (!slug) {
            return {
              ok: false as const,
              code: 'invalid_slug' as const,
              error: 'slug must match ^[a-z][a-z0-9_]{0,31}$',
            };
          }
          patch.slug = slug;
        }

        if (input.url !== undefined) {
          const urlCheck = await assertSafeMcpUrl(input.url);
          if (!urlCheck.ok) {
            return {
              ok: false as const,
              code: 'invalid_url' as const,
              error: urlCheck.error,
            };
          }
          patch.url = urlCheck.href;
        }

        if (input.enabled !== undefined) {
          patch.enabled = Boolean(input.enabled);
        }

        const rawKey =
          input.apiKey === undefined || input.apiKey === null
            ? null
            : input.apiKey.trim();
        const rotatingKey = rawKey !== null && rawKey.length > 0;

        if (rotatingKey) {
          const header =
            input.authHeaderName !== undefined
              ? normalizeHeaderName(input.authHeaderName)
              : row.authHeaderName;
          if (!header || !validateHeaderName(header)) {
            return {
              ok: false as const,
              code: 'invalid_header' as const,
              error:
                'auth header name required when API key is set (A-Za-z0-9-, ≤64)',
            };
          }
          // Lock tenant DEK via ensureTenantDek inside same txn as row update.
          const enc = await encryptTenantSecret(row.tenantId, rawKey, {
            ...deps,
            db,
            tx,
          });
          patch.authHeaderName = header;
          patch.authHeaderValueCiphertext = enc.ciphertext;
          patch.authHeaderKekVersion = enc.dekVersion;
          patch.authMode = 'api_key';
        } else if (
          input.authHeaderName !== undefined &&
          row.authMode === 'api_key'
        ) {
          // Allow renaming header without rotating key when a key already exists.
          const header = normalizeHeaderName(input.authHeaderName);
          if (!header || !validateHeaderName(header)) {
            return {
              ok: false as const,
              code: 'invalid_header' as const,
              error: 'invalid auth header name',
            };
          }
          patch.authHeaderName = header;
        }

        try {
          await tx
            .update(userMcpServers)
            .set(patch)
            .where(
              and(eq(userMcpServers.id, id), eq(userMcpServers.userId, userId)),
            );
        } catch (err) {
          if (isUniqueViolation(err)) {
            const code = uniqueCodeFromError(err);
            return {
              ok: false as const,
              code,
              error:
                code === 'duplicate_slug'
                  ? 'slug already exists for user'
                  : 'name already exists for user',
            };
          }
          throw err;
        }
        return { ok: true as const, value: { id } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not update MCP server' };
  }
}

export async function deleteUserMcpServer(
  userId: string,
  id: string,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<{ id: string }>> {
  const uid = userId?.trim();
  const sid = id?.trim();
  if (!uid || !sid) {
    return { ok: false, code: 'not_found', error: 'MCP server not found' };
  }
  try {
    return await withDb(deps, async (db) => {
      const deleted = await db
        .delete(userMcpServers)
        .where(
          and(eq(userMcpServers.id, sid), eq(userMcpServers.userId, uid)),
        )
        .returning({ id: userMcpServers.id });
      if (!deleted[0]) {
        return { ok: false, code: 'not_found', error: 'MCP server not found' };
      }
      return { ok: true, value: { id: sid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not delete MCP server' };
  }
}

export async function setUserMcpServerEnabled(
  userId: string,
  id: string,
  enabled: boolean,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<{ id: string }>> {
  return updateUserMcpServer({ userId, id, enabled }, deps);
}


/**
 * Best-effort last_error update for connect/probe failures (phase 2).
 * Never store secrets — caller must pass safe messages only.
 */
export async function setUserMcpServerLastError(
  userId: string,
  id: string,
  lastError: string | null,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<{ id: string }>> {
  const uid = userId?.trim();
  const sid = id?.trim();
  if (!uid || !sid) {
    return { ok: false, code: 'not_found', error: 'MCP server not found' };
  }

  const safe = truncateLastError(lastError);

  try {
    return await withDb(deps, async (db) => {
      const updated = await db
        .update(userMcpServers)
        .set({
          lastError: safe,
          updatedAt: new Date(),
        })
        .where(
          and(eq(userMcpServers.id, sid), eq(userMcpServers.userId, uid)),
        )
        .returning({ id: userMcpServers.id });
      if (!updated[0]) {
        return { ok: false, code: 'not_found', error: 'MCP server not found' };
      }
      return { ok: true, value: { id: sid } };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return {
      ok: false,
      code: 'unavailable',
      error: 'could not update MCP last_error',
    };
  }
}


/**
 * List servers for user — mask only, never ciphertext.
 * Decrypts under DEK solely to build mask when key present.
 */
export async function listUserMcpServers(
  userId: string,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<UserMcpServerListItem[]>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select()
        .from(userMcpServers)
        .where(eq(userMcpServers.userId, uid));

      const result: UserMcpServerListItem[] = [];
      for (const row of rows) {
        let apiKeyMask: string | null = null;
        const hasApiKey = Boolean(row.authHeaderValueCiphertext);
        if (hasApiKey && row.authHeaderValueCiphertext) {
          try {
            const plain = await decryptTenantSecret(
              row.tenantId,
              row.authHeaderValueCiphertext,
              { ...deps, db },
            );
            apiKeyMask = maskSecret(plain);
          } catch {
            apiKeyMask = '********';
          }
        }

        result.push({
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          name: row.name,
          slug: row.slug,
          url: row.url,
          transport: row.transport,
          authHeaderName: row.authHeaderName,
          authMode: row.authMode,
          enabled: row.enabled,
          hasApiKey,
          apiKeyMask,
          lastError: row.lastError,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }

      result.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, value: result };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return { ok: false, code: 'unavailable', error: 'could not list MCP servers' };
  }
}

/**
 * Server-only decrypt for runtime (phase 2). Never import from client components.
 */
export async function loadEnabledUserMcpSecrets(
  userId: string,
  deps: UserMcpServersDeps = {},
): Promise<UserMcpServerResult<UserMcpSecretRow[]>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select()
        .from(userMcpServers)
        .where(
          and(
            eq(userMcpServers.userId, uid),
            eq(userMcpServers.enabled, true),
          ),
        );

      const result: UserMcpSecretRow[] = [];
      for (const row of rows) {
        let apiKey: string | null = null;
        if (row.authHeaderValueCiphertext) {
          try {
            apiKey = await decryptTenantSecret(
              row.tenantId,
              row.authHeaderValueCiphertext,
              { ...deps, db },
            );
          } catch {
            // Soft-skip broken ciphertext; phase 2 may surface last_error.
            continue;
          }
        }
        result.push({
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          name: row.name,
          slug: row.slug,
          url: row.url,
          transport: row.transport,
          authHeaderName: row.authHeaderName,
          authMode: row.authMode,
          apiKey,
          enabled: row.enabled,
          lastError: row.lastError,
        });
      }
      return { ok: true, value: result };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { ok: false, code: 'unavailable', error: 'MCP servers unavailable' };
    }
    return {
      ok: false,
      code: 'unavailable',
      error: 'could not load MCP secrets',
    };
  }
}
