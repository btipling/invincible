/**
 * Phase 3 — resolve default sandbox + grants for an authenticated user (v1).
 * Phase 2 (#94): decrypt sandbox token via tenant DEK (dual-read / dek-only mode).
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxGrants,
  sandboxes,
  tenantMembers,
  type Db,
} from '../../db';
import { createSandboxClient, type SandboxClient } from '../sandbox/client';
import { normalizeBaseUrl } from '../sandbox/config';
import { SANDBOX_FORBIDDEN_ERROR } from './errors';
import {
  effectiveGrantPermissions,
  isUsableGrant,
  type EffectivePermissions,
} from './grants';
import { decryptSandboxToken } from './tenantKeys';

export type ResolvedAgentSandbox = {
  client: SandboxClient;
  permissions: EffectivePermissions;
  /** Plaintext secrets to scrub (includes decrypted sandbox token). */
  secrets: string[];
  sandboxId: string;
  tenantId: string;
  baseUrl: string;
};

export type ResolveAgentSandboxResult =
  | { ok: true; value: ResolvedAgentSandbox }
  | { ok: false; response: Response };

export type ResolveAgentSandboxDeps = {
  db?: Db;
  /**
   * Override sandbox-token decrypt for tests.
   * Product default: mode-aware tenant DEK (dual / dek-only).
   */
  decryptSandboxToken?: (
    tenantId: string,
    ciphertext: string,
  ) => string | Promise<string>;
  /** Override client factory for tests. */
  createClient?: (opts: { baseUrl: string; token: string }) => SandboxClient;
};

function forbidden(): ResolveAgentSandboxResult {
  return {
    ok: false,
    response: Response.json({ error: SANDBOX_FORBIDDEN_ERROR }, { status: 403 }),
  };
}

/**
 * v1: exactly one tenant membership and exactly one usable granted active sandbox.
 * Fail closed with 403 SANDBOX_FORBIDDEN_ERROR (no crypto/env details).
 */
export async function resolveAgentSandbox(
  userId: string,
  deps: ResolveAgentSandboxDeps = {},
): Promise<ResolveAgentSandboxResult> {
  const id = userId?.trim();
  if (!id) {
    return forbidden();
  }

  if (deps.db) {
    return resolveWithDb(deps.db, id, deps);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return forbidden();
  }

  const { db, client } = createDbConnection();
  try {
    return await resolveWithDb(db, id, deps);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function resolveWithDb(
  db: Db,
  userId: string,
  deps: ResolveAgentSandboxDeps,
): Promise<ResolveAgentSandboxResult> {
  try {
    const memberships = await db
      .select({
        tenantId: tenantMembers.tenantId,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));

    if (memberships.length !== 1) {
      return forbidden();
    }
    const tenantId = memberships[0].tenantId;

    const rows = await db
      .select({
        sandboxId: sandboxes.id,
        baseUrl: sandboxes.baseUrl,
        tokenCiphertext: sandboxes.tokenCiphertext,
        status: sandboxes.status,
        canRead: sandboxGrants.canRead,
        canWrite: sandboxGrants.canWrite,
      })
      .from(sandboxGrants)
      .innerJoin(sandboxes, eq(sandboxGrants.sandboxId, sandboxes.id))
      .where(
        and(eq(sandboxGrants.userId, userId), eq(sandboxes.tenantId, tenantId)),
      );

    const usable = rows.filter((r) =>
      isUsableGrant(r.status, { canRead: r.canRead, canWrite: r.canWrite }),
    );

    if (usable.length !== 1) {
      return forbidden();
    }

    const row = usable[0];
    const permissions = effectiveGrantPermissions({
      canRead: row.canRead,
      canWrite: row.canWrite,
    });

    const decrypt =
      deps.decryptSandboxToken ??
      ((tid: string, ct: string) =>
        decryptSandboxToken(tid, ct, { db }));
    let token: string;
    try {
      token = await decrypt(tenantId, row.tokenCiphertext);
    } catch {
      return forbidden();
    }
    if (!token?.trim()) {
      return forbidden();
    }

    const baseUrl = normalizeBaseUrl(row.baseUrl);
    const createClient =
      deps.createClient ??
      ((opts: { baseUrl: string; token: string }) => createSandboxClient(opts));
    const client = createClient({ baseUrl, token });

    return {
      ok: true,
      value: {
        client,
        permissions,
        secrets: [token],
        sandboxId: row.sandboxId,
        tenantId,
        baseUrl,
      },
    };
  } catch {
    // DB errors → fail closed as 403 (no internal detail to host/Wasm)
    return forbidden();
  }
}
