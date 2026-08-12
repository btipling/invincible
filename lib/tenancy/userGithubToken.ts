/**
 * Per-user GitHub PAT under tenant DEK (parent #291 / phase #292).
 * Server-only. Never log plaintext or ciphertext.
 * tenantId is always derived from loadSoleMembership — never client input.
 */
import { eq } from 'drizzle-orm';
import {
  userGithubTokens,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { loadSoleMembership } from './soleMembership';
import {
  decryptTenantSecret,
  encryptTenantSecret,
  ensureTenantDek,
  type TenantKeyDeps,
} from './tenantKeys';

/** Max PAT length after trim (parent lock: 8KiB). */
export const USER_GITHUB_TOKEN_MAX_LEN = 8192;

export type UserGithubTokenDeps = TenantKeyDeps & {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type UserGithubTokenErrorCode =
  | 'invalid_token'
  | 'no_membership'
  | 'unavailable';

export type UserGithubTokenResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UserGithubTokenErrorCode; error: string };

export type UserGithubTokenStatus = {
  configured: boolean;
  updatedAt: Date | null;
};

async function withDb<T>(
  deps: UserGithubTokenDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withConnection(deps, fn);
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

function validateRawToken(raw: string): UserGithubTokenResult<string> {
  const token = raw?.trim() ?? '';
  if (!token) {
    return { ok: false, code: 'invalid_token', error: 'token is required' };
  }
  if (token.length > USER_GITHUB_TOKEN_MAX_LEN) {
    return {
      ok: false,
      code: 'invalid_token',
      error: `token must be at most ${USER_GITHUB_TOKEN_MAX_LEN} characters`,
    };
  }
  // Reject ASCII control chars (including DEL).
  if (/[\x00-\x1f\x7f]/.test(token)) {
    return {
      ok: false,
      code: 'invalid_token',
      error: 'token must not contain control characters',
    };
  }
  return { ok: true, value: token };
}

async function resolveTenantId(
  userId: string,
  deps: UserGithubTokenDeps,
): Promise<UserGithubTokenResult<string>> {
  const membership = await loadSoleMembership(userId, { db: deps.db });
  if (!membership.ok) {
    if (membership.reason === 'db') {
      return { ok: false, code: 'unavailable', error: 'membership lookup failed' };
    }
    return { ok: false, code: 'no_membership', error: 'no sole tenant membership' };
  }
  return { ok: true, value: membership.tenantId };
}

/**
 * Encrypt and upsert the user's GitHub PAT. Replaces any existing token.
 */
export async function setUserGithubToken(
  userId: string,
  raw: string,
  deps: UserGithubTokenDeps = {},
): Promise<UserGithubTokenResult<{ updatedAt: Date }>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }
  const validated = validateRawToken(raw);
  if (!validated.ok) return validated;

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        // Lock order matches rotateTenantDek: tenant DEK first, then token row.
        const dek = await ensureTenantDek(tid.value, { ...deps, db, tx });
        await tx
          .select({ userId: userGithubTokens.userId })
          .from(userGithubTokens)
          .where(eq(userGithubTokens.userId, uid))
          .for('update')
          .limit(1);
        const enc = await encryptTenantSecret(tid.value, validated.value, {
          ...deps,
          db,
          tx,
        });
        if (enc.dekVersion !== dek.version) {
          throw new Error('DEK version changed under lock');
        }

        const now = new Date();
        await tx
          .insert(userGithubTokens)
          .values({
            userId: uid,
            tenantId: tid.value,
            tokenCiphertext: enc.ciphertext,
            tokenKekVersion: enc.dekVersion,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userGithubTokens.userId,
            set: {
              tenantId: tid.value,
              tokenCiphertext: enc.ciphertext,
              tokenKekVersion: enc.dekVersion,
              updatedAt: now,
            },
          });

        return { ok: true as const, value: { updatedAt: now } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_github_tokens table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to store token' };
  }
}

/**
 * Clear the stored PAT (null ciphertext + kek version).
 */
export async function clearUserGithubToken(
  userId: string,
  deps: UserGithubTokenDeps = {},
): Promise<UserGithubTokenResult<{ cleared: true }>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      return await db.transaction(async (tx) => {
        // Keep lock order consistent with set/rotate (tenant first).
        await ensureTenantDek(tid.value, { ...deps, db, tx });

        const existing = await tx
          .select({ userId: userGithubTokens.userId })
          .from(userGithubTokens)
          .where(eq(userGithubTokens.userId, uid))
          .for('update')
          .limit(1);

        const now = new Date();
        if (existing.length === 0) {
          // Ensure a cleared row exists so status can show updatedAt if desired;
          // plan allows null row — insert null row for stable status.
          await tx.insert(userGithubTokens).values({
            userId: uid,
            tenantId: tid.value,
            tokenCiphertext: null,
            tokenKekVersion: null,
            updatedAt: now,
          });
        } else {
          await tx
            .update(userGithubTokens)
            .set({
              tokenCiphertext: null,
              tokenKekVersion: null,
              updatedAt: now,
            })
            .where(eq(userGithubTokens.userId, uid));
        }

        return { ok: true as const, value: { cleared: true as const } };
      });
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_github_tokens table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to clear token' };
  }
}

/**
 * Mask-only status for Settings UI. Never returns ciphertext or token prefix.
 */
export async function getUserGithubTokenStatus(
  userId: string,
  deps: UserGithubTokenDeps = {},
): Promise<UserGithubTokenResult<UserGithubTokenStatus>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          tenantId: userGithubTokens.tenantId,
          tokenCiphertext: userGithubTokens.tokenCiphertext,
          updatedAt: userGithubTokens.updatedAt,
        })
        .from(userGithubTokens)
        .where(eq(userGithubTokens.userId, uid))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return {
          ok: true as const,
          value: { configured: false, updatedAt: null },
        };
      }
      // Stale row from a prior sole-membership tenant — treat as unset.
      if (row.tenantId !== tid.value) {
        return {
          ok: true as const,
          value: { configured: false, updatedAt: null },
        };
      }
      const configured = Boolean(row.tokenCiphertext?.trim());
      return {
        ok: true as const,
        value: {
          configured,
          updatedAt: row.updatedAt ?? null,
        },
      };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_github_tokens table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to load token status' };
  }
}

/**
 * Decrypt PAT for server use (agent inject phase 2). Never call from client.
 * Returns null when unset / cleared.
 */
export async function decryptUserGithubTokenForServer(
  userId: string,
  deps: UserGithubTokenDeps = {},
): Promise<UserGithubTokenResult<string | null>> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, code: 'no_membership', error: 'userId is required' };
  }

  try {
    const tid = await resolveTenantId(uid, deps);
    if (!tid.ok) return tid;

    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          tenantId: userGithubTokens.tenantId,
          tokenCiphertext: userGithubTokens.tokenCiphertext,
        })
        .from(userGithubTokens)
        .where(eq(userGithubTokens.userId, uid))
        .limit(1);

      const row = rows[0];
      if (!row || row.tenantId !== tid.value) {
        // Missing row or tenant mismatch (membership moved) → unset for inject.
        return { ok: true as const, value: null };
      }
      const ct = row.tokenCiphertext?.trim() ?? '';
      if (!ct) {
        return { ok: true as const, value: null };
      }
      const plain = await decryptTenantSecret(tid.value, ct, { ...deps, db });
      return { ok: true as const, value: plain };
    });
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        ok: false,
        code: 'unavailable',
        error:
          'user_github_tokens table missing — run GHA db-migrate (confirm=migrate)',
      };
    }
    return { ok: false, code: 'unavailable', error: 'failed to decrypt token' };
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createUserGithubToken(deps: UserGithubTokenDeps = {}) {
  return {
    setUserGithubToken: (userId: string, raw: string, o?: UserGithubTokenDeps) =>
      setUserGithubToken(userId, raw, { ...deps, ...o }),
    clearUserGithubToken: (userId: string, o?: UserGithubTokenDeps) =>
      clearUserGithubToken(userId, { ...deps, ...o }),
    getUserGithubTokenStatus: (userId: string, o?: UserGithubTokenDeps) =>
      getUserGithubTokenStatus(userId, { ...deps, ...o }),
    decryptUserGithubTokenForServer: (userId: string, o?: UserGithubTokenDeps) =>
      decryptUserGithubTokenForServer(userId, { ...deps, ...o }),
  };
}
