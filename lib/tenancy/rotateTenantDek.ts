/**
 * Phase 3 (#95 / parent #92): owner-only tenant DEK rotation.
 * Re-encrypts all sandbox tokens under a new DEK; bumps dek_version atomically.
 * Never returns key material.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxes,
  tenantMembers,
  tenants,
  type Db,
} from '../../db';
import {
  decryptSecret,
  encryptSecret,
  resolveCredentialsKey,
} from './credentials';
import { canRotateSandboxToken } from './roles';
import {
  generateTenantDek,
  resolveTokenDecryptMode,
  wrapTenantDek,
  unwrapTenantDek,
  type TokenDecryptMode,
} from './tenantKeys';

export type RotateTenantDekResult =
  | { ok: true; dekVersion: number }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'db' };

export type RotateTenantDekDeps = {
  db?: Db;
  /** Explicit AMK for tests / inject. */
  amk?: Buffer;
  /** Decrypt mode for leftover AMK ciphertext; defaults to resolveTokenDecryptMode(). */
  mode?: TokenDecryptMode;
};

/**
 * Owner-only: generate a new tenant DEK, re-encrypt every sandbox token, bump versions.
 * Single transaction + SELECT … FOR UPDATE on the tenant row.
 */
export async function rotateTenantDek(
  userId: string,
  tenantId: string,
  deps: RotateTenantDekDeps = {},
): Promise<RotateTenantDekResult> {
  const uid = userId?.trim();
  const tid = tenantId?.trim();
  if (!uid || !tid) {
    return { ok: false, reason: 'forbidden' };
  }

  if (deps.db) {
    return rotateWithDb(deps.db, uid, tid, deps);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, reason: 'db' };
  }

  const { db, client } = createDbConnection();
  try {
    return await rotateWithDb(db, uid, tid, deps);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function decryptTokenForRotate(
  ciphertext: string,
  oldDek: Buffer,
  amk: Buffer,
  mode: TokenDecryptMode,
): string {
  try {
    return decryptSecret(ciphertext, oldDek);
  } catch {
    if (mode === 'dual') {
      return decryptSecret(ciphertext, amk);
    }
    throw new Error('token decrypt failed under current DEK');
  }
}

async function rotateWithDb(
  db: Db,
  userId: string,
  tenantId: string,
  deps: RotateTenantDekDeps,
): Promise<RotateTenantDekResult> {
  try {
    const memberships = await db
      .select({
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
        ),
      )
      .limit(1);

    const membership = memberships[0];
    if (!membership) {
      return { ok: false, reason: 'not_found' };
    }
    if (!canRotateSandboxToken(membership.role)) {
      return { ok: false, reason: 'forbidden' };
    }

    const amk = deps.amk ?? resolveCredentialsKey();
    const mode = deps.mode ?? resolveTokenDecryptMode();

    const newVersion = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: tenants.id,
          dekCiphertext: tenants.dekCiphertext,
          dekVersion: tenants.dekVersion,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update')
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new Error('tenant not found');
      }
      if (!row.dekCiphertext) {
        throw new Error('tenant DEK not provisioned');
      }

      const oldDek = unwrapTenantDek(row.dekCiphertext, amk);
      const oldVersion = row.dekVersion;
      const nextVersion = oldVersion + 1;
      const newDek = generateTenantDek();
      const wrapped = wrapTenantDek(newDek, amk);

      const sbRows = await tx
        .select({
          id: sandboxes.id,
          tokenCiphertext: sandboxes.tokenCiphertext,
        })
        .from(sandboxes)
        .where(eq(sandboxes.tenantId, tenantId));

      for (const sb of sbRows) {
        const plain = decryptTokenForRotate(
          sb.tokenCiphertext,
          oldDek,
          amk,
          mode,
        );
        const nextCt = encryptSecret(plain, newDek);
        await tx
          .update(sandboxes)
          .set({
            tokenCiphertext: nextCt,
            tokenKekVersion: nextVersion,
          })
          .where(eq(sandboxes.id, sb.id));
      }

      await tx
        .update(tenants)
        .set({
          dekCiphertext: wrapped,
          dekVersion: nextVersion,
        })
        .where(eq(tenants.id, tenantId));

      return nextVersion;
    });

    return { ok: true, dekVersion: newVersion };
  } catch {
    return { ok: false, reason: 'db' };
  }
}
