/**
 * Per-tenant DEK envelope helpers (phase 1 — parent #92 / phase #93).
 *
 * AMK (CREDENTIALS_ENCRYPTION_KEY) wraps each tenant DEK.
 * Sandbox tokens are re-encrypted under the tenant DEK by backfill / phase 2 call sites.
 * Never log DEK, AMK, or token plaintext/ciphertext.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxes,
  tenants,
  type Db,
} from '../../db';
import {
  CredentialsError,
  decryptSecret,
  encryptSecret,
  resolveCredentialsKey,
} from './credentials';

const DEK_LENGTH = 32;

export type TenantKeyDeps = {
  db?: Db;
  /** Explicit AMK; defaults to resolveCredentialsKey(). */
  amk?: Buffer;
};

export type TenantDek = {
  dek: Buffer;
  version: number;
};

function resolveAmk(deps: TenantKeyDeps): Buffer {
  return deps.amk ?? resolveCredentialsKey();
}

async function withDb<T>(
  deps: TenantKeyDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) {
    return fn(deps.db);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new CredentialsError('DATABASE_URL is required');
  }
  const { db, client } = createDbConnection();
  try {
    return await fn(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Generate a fresh 32-byte tenant DEK. */
export function generateTenantDek(): Buffer {
  return randomBytes(DEK_LENGTH);
}

/**
 * Wrap DEK under AMK: encrypt base64(DEK) with encryptSecret.
 * Never log plaintext DEK or ciphertext.
 */
export function wrapTenantDek(dek: Buffer, amk?: Buffer): string {
  if (dek.length !== DEK_LENGTH) {
    throw new CredentialsError(
      `tenant DEK must be ${DEK_LENGTH} bytes (got ${dek.length})`,
    );
  }
  const key = amk ?? resolveCredentialsKey();
  return encryptSecret(dek.toString('base64'), key);
}

/**
 * Unwrap AMK-wrapped DEK. Enforces 32-byte length after base64 decode.
 */
export function unwrapTenantDek(ciphertext: string, amk?: Buffer): Buffer {
  const key = amk ?? resolveCredentialsKey();
  const b64 = decryptSecret(ciphertext, key);
  let dek: Buffer;
  try {
    dek = Buffer.from(b64, 'base64');
  } catch {
    throw new CredentialsError('invalid DEK encoding');
  }
  if (dek.length !== DEK_LENGTH) {
    throw new CredentialsError(
      `unwrapped DEK must be ${DEK_LENGTH} bytes (got ${dek.length})`,
    );
  }
  return dek;
}

/**
 * Ensure tenant has a DEK. Transaction + SELECT … FOR UPDATE.
 * Never overwrites a non-null dek_ciphertext.
 */
export async function ensureTenantDek(
  tenantId: string,
  deps: TenantKeyDeps = {},
): Promise<TenantDek> {
  const id = tenantId?.trim();
  if (!id) {
    throw new CredentialsError('tenantId is required');
  }
  const amk = resolveAmk(deps);

  return withDb(deps, async (db) => {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: tenants.id,
          dekCiphertext: tenants.dekCiphertext,
          dekVersion: tenants.dekVersion,
        })
        .from(tenants)
        .where(eq(tenants.id, id))
        .for('update')
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new CredentialsError('tenant not found');
      }

      if (row.dekCiphertext) {
        const dek = unwrapTenantDek(row.dekCiphertext, amk);
        return { dek, version: row.dekVersion };
      }

      const dek = generateTenantDek();
      const wrapped = wrapTenantDek(dek, amk);
      const version = row.dekVersion;

      await tx
        .update(tenants)
        .set({ dekCiphertext: wrapped })
        .where(eq(tenants.id, id));

      return { dek, version };
    });
  });
}

/**
 * Load existing tenant DEK. Fail closed if missing.
 */
export async function loadTenantDek(
  tenantId: string,
  deps: TenantKeyDeps = {},
): Promise<TenantDek> {
  const id = tenantId?.trim();
  if (!id) {
    throw new CredentialsError('tenantId is required');
  }
  const amk = resolveAmk(deps);

  return withDb(deps, async (db) => {
    const rows = await db
      .select({
        dekCiphertext: tenants.dekCiphertext,
        dekVersion: tenants.dekVersion,
      })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new CredentialsError('tenant not found');
    }
    if (!row.dekCiphertext) {
      throw new CredentialsError('tenant DEK not provisioned');
    }
    const dek = unwrapTenantDek(row.dekCiphertext, amk);
    return { dek, version: row.dekVersion };
  });
}

/**
 * Encrypt a secret under the tenant DEK (ensure DEK exists).
 * Returns ciphertext + dekVersion for token_kek_version writers.
 */
export async function encryptTenantSecret(
  tenantId: string,
  plaintext: string,
  deps: TenantKeyDeps = {},
): Promise<{ ciphertext: string; dekVersion: number }> {
  const { dek, version } = await ensureTenantDek(tenantId, deps);
  const ciphertext = encryptSecret(plaintext, dek);
  return { ciphertext, dekVersion: version };
}

/**
 * Decrypt a secret under the tenant DEK (must already exist).
 */
export async function decryptTenantSecret(
  tenantId: string,
  ciphertext: string,
  deps: TenantKeyDeps = {},
): Promise<string> {
  const { dek } = await loadTenantDek(tenantId, deps);
  return decryptSecret(ciphertext, dek);
}

export type BackfillResult = {
  tenantsUpdated: number;
  sandboxesReencrypted: number;
};

/**
 * Idempotent: ensure DEK for every tenant; re-encrypt legacy AMK sandbox tokens under DEK.
 *
 * PRODUCTION GATE: do **not** run against origin Production while the live app still
 * decrypts sandbox tokens with AMK only (phase 1). Wait until phase 2 dual-read
 * (or maintenance-window DEK-only app) is deployed — see parent #92 cutover.
 * Safe anytime on PGlite / throwaway DBs.
 *
 * Returns counts only — never logs secrets.
 */
export async function backfillTenantDeks(
  deps: TenantKeyDeps = {},
): Promise<BackfillResult> {
  const amk = resolveAmk(deps);

  return withDb(deps, async (db) => {
    let tenantsUpdated = 0;
    let sandboxesReencrypted = 0;

    const allTenants = await db
      .select({
        id: tenants.id,
        dekCiphertext: tenants.dekCiphertext,
      })
      .from(tenants);

    for (const t of allTenants) {
      const hadDek = Boolean(t.dekCiphertext);
      const { dek, version } = await ensureTenantDek(t.id, { db, amk });
      if (!hadDek) {
        tenantsUpdated += 1;
      }

      const sbRows = await db
        .select({
          id: sandboxes.id,
          tokenCiphertext: sandboxes.tokenCiphertext,
        })
        .from(sandboxes)
        .where(eq(sandboxes.tenantId, t.id));

      for (const sb of sbRows) {
        let plain: string | null = null;
        let legacy = false;

        try {
          plain = decryptSecret(sb.tokenCiphertext, amk);
          legacy = true;
        } catch {
          try {
            decryptSecret(sb.tokenCiphertext, dek);
            // already under DEK — skip
            continue;
          } catch {
            throw new CredentialsError(
              'sandbox token decrypt failed under AMK and tenant DEK',
            );
          }
        }

        if (legacy && plain !== null) {
          const nextCt = encryptSecret(plain, dek);
          await db
            .update(sandboxes)
            .set({
              tokenCiphertext: nextCt,
              tokenKekVersion: version,
            })
            .where(eq(sandboxes.id, sb.id));
          sandboxesReencrypted += 1;
        }
      }
    }

    return { tenantsUpdated, sandboxesReencrypted };
  });
}
