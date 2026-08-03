/**
 * Phase 4 — owner-only rotate sandbox token (re-encrypt at rest).
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxes,
  tenantMembers,
  type Db,
} from '../../db';
import {
  CURRENT_KEK_VERSION,
  encryptSecret,
} from './credentials';
import { canRotateSandboxToken } from './roles';

export type RotateResult =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'empty' | 'db' };

export type RotateDeps = {
  db?: Db;
  encrypt?: (plaintext: string) => string;
};

/**
 * Re-encrypt and persist a new sandbox token for an owner of the sandbox's tenant.
 * Never returns the token.
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

  if (deps.db) {
    return rotateWithDb(deps.db, uid, sid, token, deps);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return { ok: false, reason: 'db' };
  }

  const { db, client } = createDbConnection();
  try {
    return await rotateWithDb(db, uid, sid, token, deps);
  } finally {
    await client.end({ timeout: 5 });
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
    const rows = await db
      .select({
        sandboxId: sandboxes.id,
        tenantId: sandboxes.tenantId,
        role: tenantMembers.role,
      })
      .from(sandboxes)
      .innerJoin(
        tenantMembers,
        and(
          eq(tenantMembers.tenantId, sandboxes.tenantId),
          eq(tenantMembers.userId, userId),
        ),
      )
      .where(eq(sandboxes.id, sandboxId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    if (!canRotateSandboxToken(row.role)) {
      return { ok: false, reason: 'forbidden' };
    }

    const encrypt =
      deps.encrypt ?? ((plaintext: string) => encryptSecret(plaintext));
    const ciphertext = encrypt(newToken.trim());

    await db
      .update(sandboxes)
      .set({
        tokenCiphertext: ciphertext,
        tokenKekVersion: CURRENT_KEK_VERSION,
      })
      .where(eq(sandboxes.id, sandboxId));

    return { ok: true };
  } catch {
    return { ok: false, reason: 'db' };
  }
}
