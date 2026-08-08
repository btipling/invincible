/**
 * Owner-only tenant DEK rotation.
 * Re-encrypts all sandbox tokens, provider secret credentials, and non-null
 * user_mcp_servers header ciphertexts and user_github_tokens under a new DEK; bumps dek_version
 * atomically. Never returns key material.
 *
 * Concurrency: SELECT … FOR UPDATE on the tenant row (and sandboxes / secrets /
 * MCP / GitHub token rows) for the full re-encrypt so concurrent writers cannot write under a
 * discarded DEK. Authz is re-checked under the same lock.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  providerSecrets,
  sandboxes,
  tenantMembers,
  tenants,
  userMcpServers,
  userGithubTokens,
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
 * Owner-only: generate a new tenant DEK, re-encrypt every sandbox token,
 * provider_secrets credential, non-null user_mcp_servers header ciphertext,
 * and non-null user_github_tokens ciphertext, bump versions.
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

/** Provider secrets are DEK-only — no AMK dual-read. */
function decryptProviderCredential(ciphertext: string, oldDek: Buffer): string {
  return decryptSecret(ciphertext, oldDek);
}

async function rotateWithDb(
  db: Db,
  userId: string,
  tenantId: string,
  deps: RotateTenantDekDeps,
): Promise<RotateTenantDekResult> {
  try {
    const amk = deps.amk ?? resolveCredentialsKey();
    const mode = deps.mode ?? resolveTokenDecryptMode();

    return await db.transaction(async (tx) => {
      // Lock tenant first — serializes concurrent DEK rotates and token rotates.
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
        return { ok: false as const, reason: 'not_found' as const };
      }

      // Authz under the same lock (closes demotion TOCTOU).
      const memberships = await tx
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
        return { ok: false as const, reason: 'not_found' as const };
      }
      if (!canRotateSandboxToken(membership.role)) {
        return { ok: false as const, reason: 'forbidden' as const };
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
        .where(eq(sandboxes.tenantId, tenantId))
        .for('update');

      for (const sb of sbRows) {
        // Vercel backend rows store null credentials (#281) — skip.
        const ct = sb.tokenCiphertext?.trim() ?? '';
        if (!ct) {
          continue;
        }
        const plain = decryptTokenForRotate(
          ct,
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

      // Provider secrets: DEK-only (no AMK dual-read).
      const secretRows = await tx
        .select({
          id: providerSecrets.id,
          credentialCiphertext: providerSecrets.credentialCiphertext,
        })
        .from(providerSecrets)
        .where(eq(providerSecrets.tenantId, tenantId))
        .for('update');

      for (const sec of secretRows) {
        const plain = decryptProviderCredential(
          sec.credentialCiphertext,
          oldDek,
        );
        const nextCt = encryptSecret(plain, newDek);
        await tx
          .update(providerSecrets)
          .set({
            credentialCiphertext: nextCt,
            credentialKekVersion: nextVersion,
            updatedAt: new Date(),
          })
          .where(eq(providerSecrets.id, sec.id));
      }

      // MCP header secrets: DEK-only; skip null ciphertext (auth_mode=none).
      const mcpRows = await tx
        .select({
          id: userMcpServers.id,
          authHeaderValueCiphertext: userMcpServers.authHeaderValueCiphertext,
        })
        .from(userMcpServers)
        .where(eq(userMcpServers.tenantId, tenantId))
        .for('update');

      for (const mcp of mcpRows) {
        if (!mcp.authHeaderValueCiphertext) {
          continue;
        }
        const plain = decryptProviderCredential(
          mcp.authHeaderValueCiphertext,
          oldDek,
        );
        const nextCt = encryptSecret(plain, newDek);
        await tx
          .update(userMcpServers)
          .set({
            authHeaderValueCiphertext: nextCt,
            authHeaderKekVersion: nextVersion,
            updatedAt: new Date(),
          })
          .where(eq(userMcpServers.id, mcp.id));
      }

      // GitHub PATs: DEK-only; skip null ciphertext (cleared / unset).
      const ghRows = await tx
        .select({
          userId: userGithubTokens.userId,
          tokenCiphertext: userGithubTokens.tokenCiphertext,
        })
        .from(userGithubTokens)
        .where(eq(userGithubTokens.tenantId, tenantId))
        .for('update');

      for (const gh of ghRows) {
        if (!gh.tokenCiphertext) {
          continue;
        }
        const plain = decryptProviderCredential(gh.tokenCiphertext, oldDek);
        const nextCt = encryptSecret(plain, newDek);
        await tx
          .update(userGithubTokens)
          .set({
            tokenCiphertext: nextCt,
            tokenKekVersion: nextVersion,
            updatedAt: new Date(),
          })
          .where(eq(userGithubTokens.userId, gh.userId));
      }

      await tx
        .update(tenants)
        .set({
          dekCiphertext: wrapped,
          dekVersion: nextVersion,
        })
        .where(eq(tenants.id, tenantId));

      return { ok: true as const, dekVersion: nextVersion };
    });
  } catch {
    return { ok: false, reason: 'db' };
  }
}
