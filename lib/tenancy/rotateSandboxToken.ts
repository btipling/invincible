/**
 * Owner-only rotate sandbox token (re-encrypt at rest).
 * Phase 2 (#94): re-encrypt under tenant DEK; token_kek_version = dek_version.
 * Phase 4 (#284): reject backend=vercel (no BYO token).
 * Holds tenant SELECT … FOR UPDATE for ensure+encrypt+write so concurrent
 * rotateTenantDek cannot interleave a discarded DEK.
 */
import { and, eq } from 'drizzle-orm';
import {
  sandboxes,
  tenantMembers,
  tenants,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { encryptSecret } from './credentials';
import { canRotateSandboxToken } from './roles';
import { ensureTenantDek } from './tenantKeys';

export type RotateResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'forbidden' | 'not_found' | 'empty' | 'wrong_backend' | 'db';
    };

export type RotateDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
  /** Explicit AMK for tests / inject. */
  amk?: Buffer;
  /** Override encrypt for tests: (plaintext, dek) => ciphertext */
  encrypt?: (plaintext: string, dek: Buffer) => string;
};

/**
 * Re-encrypt and persist a new sandbox token for an owner of the sandbox's tenant.
 * Never returns the token. Fails for backend=vercel.
 */
export async function rotateSandboxToken(
  userId: string,
  sandboxId: string,
  newToken: string,
  deps: RotateDeps = {},
): Promise<RotateResult> {
  const uid = userId?.trim();
  const sid = sandboxId?.trim();
  const token = newToken ?? '';
  if (!uid || !sid) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!token.trim()) {
    return { ok: false, reason: 'empty' };
  }

  try {
    return await withConnection(deps, (db) =>
      rotateWithDb(db, uid, sid, token, deps),
    );
  } catch {
    return { ok: false, reason: 'db' };
  }
}

async function rotateWithDb(
  db: Db,
  userId: string,
  sandboxId: string,
  newToken: string,
  deps: RotateDeps,
): Promise<RotateResult> {
  try {
    return await db.transaction(async (tx) => {
      const sbRows = await tx
        .select({
          id: sandboxes.id,
          tenantId: sandboxes.tenantId,
          backend: sandboxes.backend,
        })
        .from(sandboxes)
        .where(eq(sandboxes.id, sandboxId))
        .limit(1);

      const sb = sbRows[0];
      if (!sb) {
        return { ok: false as const, reason: 'not_found' as const };
      }

      const backend = (sb.backend ?? 'byo').trim();
      if (backend === 'vercel') {
        return { ok: false as const, reason: 'wrong_backend' as const };
      }

      // Serialize with rotateTenantDek: hold tenant row for ensure + write.
      const tenantRows = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, sb.tenantId))
        .for('update')
        .limit(1);

      if (!tenantRows[0]) {
        return { ok: false as const, reason: 'not_found' as const };
      }

      const memberships = await tx
        .select({ role: tenantMembers.role })
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.tenantId, sb.tenantId),
            eq(tenantMembers.userId, userId),
          ),
        )
        .limit(1);

      const membership = memberships[0];
      if (!membership) {
        return { ok: false as const, reason: 'not_found' as const };
      }
      if (!canRotateSandboxToken(membership.role)) {
        return { ok: false as const, reason: 'forbidden' as const };
      }

      const { dek, version } = await ensureTenantDek(sb.tenantId, {
        tx,
        amk: deps.amk,
      });
      const encrypt =
        deps.encrypt ??
        ((plaintext: string, key: Buffer) => encryptSecret(plaintext, key));
      const ciphertext = encrypt(newToken.trim(), dek);

      await tx
        .update(sandboxes)
        .set({
          tokenCiphertext: ciphertext,
          tokenKekVersion: version,
        })
        .where(eq(sandboxes.id, sandboxId));

      return { ok: true as const };
    });
  } catch {
    return { ok: false, reason: 'db' };
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createRotateSandboxToken(deps: RotateDeps = {}) {
  return {
    rotateSandboxToken: (userId: string, sandboxId: string, newToken: string, o?: RotateDeps) =>
      rotateSandboxToken(userId, sandboxId, newToken, { ...deps, ...o }),
  };
}
