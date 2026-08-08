/**
 * Resolve default sandbox + grants for an authenticated user (v1).
 * Phase 3 (#283 / parent #280): branch on per-row `backend` (byo | vercel) and
 * pass `image` into the Vercel SandboxClient factory.
 * Phase 2 (#94): decrypt sandbox token via tenant DEK (dual-read / dek-only mode) for byo only.
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
import {
  createVercelSandboxClient,
  type CreateVercelSandboxClientOptions,
} from '../sandbox/vercelClient';
import { SANDBOX_FORBIDDEN_ERROR } from './errors';
import {
  effectiveGrantPermissions,
  isUsableGrant,
  type EffectivePermissions,
} from './grants';
import {
  isSandboxBackend,
  resolveVercelSandboxImage,
  type SandboxBackend,
} from './sandboxBackend';
import { decryptSandboxToken } from './tenantKeys';

export type ResolvedAgentSandbox = {
  client: SandboxClient;
  permissions: EffectivePermissions;
  /** Plaintext secrets to scrub (BYO decrypted token only; empty for vercel). */
  secrets: string[];
  sandboxId: string;
  tenantId: string;
  backend: SandboxBackend;
  /** Present for byo only — never invent a host URL for vercel. */
  baseUrl?: string;
  /** Resolved Vercel image ref; null for byo. */
  resolvedImage: string | null;
};

export type ResolveAgentSandboxResult =
  | { ok: true; value: ResolvedAgentSandbox }
  | { ok: false; response: Response };

export type ResolveAgentSandboxDeps = {
  db?: Db;
  /**
   * Override sandbox-token decrypt for tests.
   * Product default: mode-aware tenant DEK (dual / dek-only).
   * Never called for backend=vercel.
   */
  decryptSandboxToken?: (
    tenantId: string,
    ciphertext: string,
  ) => string | Promise<string>;
  /** BYO HTTP client factory (tests). */
  createByoClient?: (opts: { baseUrl: string; token: string }) => SandboxClient;
  /**
   * @deprecated Prefer createByoClient. Alias kept for older tests.
   */
  createClient?: (opts: { baseUrl: string; token: string }) => SandboxClient;
  /** Vercel FS client factory (tests). Receives raw row image. */
  createVercelClient?: (
    opts: Pick<CreateVercelSandboxClientOptions, 'image'>,
  ) => SandboxClient;
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
        backend: sandboxes.backend,
        image: sandboxes.image,
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

    const backendRaw = (row.backend ?? 'byo').trim();
    if (!isSandboxBackend(backendRaw)) {
      return forbidden();
    }
    const backend: SandboxBackend = backendRaw;

    if (backend === 'vercel') {
      // Never decrypt BYO token for vercel rows (even if stale ciphertext remains).
      const image = row.image;
      const resolvedImg = resolveVercelSandboxImage(image);
      if (!resolvedImg.ok) {
        return forbidden();
      }

      let client: SandboxClient;
      try {
        const createVercel =
          deps.createVercelClient ??
          ((opts: Pick<CreateVercelSandboxClientOptions, 'image'>) =>
            createVercelSandboxClient(opts));
        client = createVercel({ image });
      } catch {
        // Invalid image / factory throw — fail closed, no message leak.
        return forbidden();
      }

      return {
        ok: true,
        value: {
          client,
          permissions,
          secrets: [],
          sandboxId: row.sandboxId,
          tenantId,
          backend: 'vercel',
          resolvedImage: resolvedImg.image,
        },
      };
    }

    // backend === 'byo'
    const baseUrlRaw = row.baseUrl?.trim() ?? '';
    const tokenCt = row.tokenCiphertext?.trim() ?? '';
    if (!baseUrlRaw || !tokenCt) {
      return forbidden();
    }

    const decrypt =
      deps.decryptSandboxToken ??
      ((tid: string, ct: string) => decryptSandboxToken(tid, ct, { db }));
    let token: string;
    try {
      token = await decrypt(tenantId, tokenCt);
    } catch {
      return forbidden();
    }
    if (!token?.trim()) {
      return forbidden();
    }

    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    const createByo =
      deps.createByoClient ??
      deps.createClient ??
      ((opts: { baseUrl: string; token: string }) => createSandboxClient(opts));
    const client = createByo({ baseUrl, token });

    return {
      ok: true,
      value: {
        client,
        permissions,
        secrets: [token],
        sandboxId: row.sandboxId,
        tenantId,
        backend: 'byo',
        baseUrl,
        resolvedImage: null,
      },
    };
  } catch {
    // DB errors → fail closed as 403 (no internal detail to host/Wasm)
    return forbidden();
  }
}
