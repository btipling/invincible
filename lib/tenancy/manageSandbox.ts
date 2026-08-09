/**
 * Admin create/update for per-tenant sandboxes (phase 4 / #284).
 * Grants: actor R/W on the target row on create. Other grants are kept so
 * users can hold multiple sandboxes and pick a preferred one in Settings.
 */
import { and, eq } from 'drizzle-orm';
import {
  createDbConnection,
  sandboxGrants,
  sandboxes,
  tenantMembers,
  tenants,
  type Db,
} from '../../db';
import { encryptSecret } from './credentials';
import { canAccessAdmin } from './roles';
import {
  assertSandboxCredentials,
  isSandboxBackend,
  isValidByoBaseUrl,
  normalizeSandboxFieldsForBackend,
  parseVercelSandboxImageInput,
  type SandboxBackend,
} from './sandboxBackend';
import { ensureTenantDek } from './tenantKeys';

export type ManageSandboxResult =
  | { ok: true; sandboxId: string }
  | {
      ok: false;
      reason:
        | 'forbidden'
        | 'not_found'
        | 'validation'
        | 'conflict'
        | 'db';
      error?: string;
    };

export type ManageSandboxDeps = {
  db?: Db;
  amk?: Buffer;
  encrypt?: (plaintext: string, dek: Buffer) => string;
};

export type CreateSandboxInput = {
  name: string;
  slug: string;
  backend: string;
  /** BYO base URL (ignored for vercel). */
  baseUrl?: string | null;
  /** BYO plaintext token (ignored for vercel). */
  token?: string | null;
  /**
   * Vercel image: null/empty → store null (runtime default).
   * Non-empty must pass shape validation.
   */
  image?: string | null;
};

export type UpdateSandboxInput = {
  sandboxId: string;
  name?: string;
  backend?: string;
  baseUrl?: string | null;
  /**
   * BYO: omit/empty = leave ciphertext unchanged; non-empty = re-encrypt.
   * Vercel: ignored (forced null).
   */
  token?: string | null;
  image?: string | null;
};

function slugOk(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug);
}


function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === 'object') {
      const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
      if (o.code === '23505') return true;
      const msg = typeof o.message === 'string' ? o.message : '';
      if (/unique|duplicate/i.test(msg)) return true;
      cur = o.cause;
      continue;
    }
    if (typeof cur === 'string' && /unique|duplicate/i.test(cur)) return true;
    break;
  }
  return false;
}


/**
 * Create a sandbox for the actor's sole tenant membership.
 * Grants actor R/W and revokes their other grants on this tenant.
 */
export async function createSandboxForAdmin(
  userId: string,
  input: CreateSandboxInput,
  deps: ManageSandboxDeps = {},
): Promise<ManageSandboxResult> {
  const uid = userId?.trim();
  if (!uid) return { ok: false, reason: 'forbidden' };

  const name = (input.name ?? '').trim();
  const slug = (input.slug ?? '').trim().toLowerCase();
  if (!name) {
    return { ok: false, reason: 'validation', error: 'Name is required.' };
  }
  if (!slug || !slugOk(slug)) {
    return {
      ok: false,
      reason: 'validation',
      error: 'Slug must be 1–64 chars: lowercase letters, digits, hyphens.',
    };
  }
  if (!isSandboxBackend(input.backend)) {
    return { ok: false, reason: 'validation', error: 'Backend must be byo or vercel.' };
  }
  const backend: SandboxBackend = input.backend;

  let imageForStore: string | null = null;
  if (backend === 'vercel') {
    const parsed = parseVercelSandboxImageInput(input.image);
    if (!parsed.ok) {
      return { ok: false, reason: 'validation', error: parsed.error };
    }
    imageForStore = parsed.image;
  }

  const plainToken = backend === 'byo' ? (input.token ?? '').trim() : '';
  const baseUrlRaw = backend === 'byo' ? (input.baseUrl ?? '').trim() : '';
  if (backend === 'byo') {
    if (!baseUrlRaw) {
      return { ok: false, reason: 'validation', error: 'Base URL is required for BYO.' };
    }
    if (!isValidByoBaseUrl(baseUrlRaw)) {
      return {
        ok: false,
        reason: 'validation',
        error: 'Base URL must be an absolute http(s) URL.',
      };
    }
    if (!plainToken) {
      return { ok: false, reason: 'validation', error: 'Token is required for BYO.' };
    }
  }

  const run = async (db: Db): Promise<ManageSandboxResult> => {
    try {
      return await db.transaction(async (tx) => {
        const memberships = await tx
          .select({
            tenantId: tenantMembers.tenantId,
            role: tenantMembers.role,
          })
          .from(tenantMembers)
          .where(eq(tenantMembers.userId, uid));

        if (memberships.length !== 1) {
          return { ok: false as const, reason: 'forbidden' as const };
        }
        const { tenantId, role } = memberships[0];
        if (!canAccessAdmin(role)) {
          return { ok: false as const, reason: 'forbidden' as const };
        }

        await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for('update')
          .limit(1);

        let tokenCiphertext: string | null = null;
        let tokenKekVersion = 1;
        if (backend === 'byo') {
          const { dek, version } = await ensureTenantDek(tenantId, {
            tx: tx as never,
            amk: deps.amk,
          });
          tokenKekVersion = version;
          const encrypt =
            deps.encrypt ??
            ((plaintext: string, key: Buffer) => encryptSecret(plaintext, key));
          tokenCiphertext = encrypt(plainToken, dek);
        }

        const fields = normalizeSandboxFieldsForBackend({
          backend,
          baseUrl: backend === 'byo' ? baseUrlRaw : null,
          tokenCiphertext,
          image: imageForStore,
        });
        const creds = assertSandboxCredentials(fields);
        if (!creds.ok) {
          return {
            ok: false as const,
            reason: 'validation' as const,
            error: creds.error,
          };
        }

        let inserted: { id: string }[];
        try {
          inserted = await tx
            .insert(sandboxes)
            .values({
              tenantId,
              name,
              slug,
              backend: fields.backend,
              image: fields.image,
              baseUrl: fields.baseUrl,
              tokenCiphertext: fields.tokenCiphertext,
              tokenKekVersion,
              status: 'active',
            })
            .returning({ id: sandboxes.id });
        } catch (err) {
          if (isUniqueViolation(err)) {
            return {
              ok: false as const,
              reason: 'conflict' as const,
              error: 'A sandbox with this slug already exists.',
            };
          }
          throw err;
        }

        const sandboxId = inserted[0]?.id;
        if (!sandboxId) {
          return { ok: false as const, reason: 'db' as const };
        }

        // Keep existing grants so multi-sandbox + Settings preference works.
        // Upsert actor R/W on the new row only.
        await tx
          .insert(sandboxGrants)
          .values({
            sandboxId,
            userId: uid,
            canRead: true,
            canWrite: true,
          })
          .onConflictDoUpdate({
            target: [sandboxGrants.sandboxId, sandboxGrants.userId],
            set: { canRead: true, canWrite: true },
          });

        return { ok: true as const, sandboxId };
      });
    } catch {
      return { ok: false, reason: 'db' };
    }
  };

  if (deps.db) return run(deps.db);
  if (!process.env.DATABASE_URL?.trim()) return { ok: false, reason: 'db' };
  const { db, client } = createDbConnection();
  try {
    return await run(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Update sandbox fields for an admin of the sandbox's tenant.
 */
export async function updateSandboxForAdmin(
  userId: string,
  input: UpdateSandboxInput,
  deps: ManageSandboxDeps = {},
): Promise<ManageSandboxResult> {
  const uid = userId?.trim();
  const sid = input.sandboxId?.trim();
  if (!uid || !sid) return { ok: false, reason: 'forbidden' };

  const run = async (db: Db): Promise<ManageSandboxResult> => {
    try {
      return await db.transaction(async (tx) => {
        const sbRows = await tx
          .select({
            id: sandboxes.id,
            tenantId: sandboxes.tenantId,
            name: sandboxes.name,
            backend: sandboxes.backend,
            baseUrl: sandboxes.baseUrl,
            tokenCiphertext: sandboxes.tokenCiphertext,
            image: sandboxes.image,
            tokenKekVersion: sandboxes.tokenKekVersion,
          })
          .from(sandboxes)
          .where(eq(sandboxes.id, sid))
          .limit(1);
        const sb = sbRows[0];
        if (!sb) return { ok: false as const, reason: 'not_found' as const };

        const memberships = await tx
          .select({ role: tenantMembers.role })
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.tenantId, sb.tenantId),
              eq(tenantMembers.userId, uid),
            ),
          )
          .limit(1);
        const membership = memberships[0];
        if (!membership) return { ok: false as const, reason: 'not_found' as const };
        if (!canAccessAdmin(membership.role)) {
          return { ok: false as const, reason: 'forbidden' as const };
        }

        await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, sb.tenantId))
          .for('update')
          .limit(1);

        const name = input.name !== undefined ? input.name.trim() : sb.name;
        if (!name) {
          return {
            ok: false as const,
            reason: 'validation' as const,
            error: 'Name is required.',
          };
        }

        const backendRaw = input.backend ?? sb.backend;
        if (!isSandboxBackend(backendRaw)) {
          return {
            ok: false as const,
            reason: 'validation' as const,
            error: 'Backend must be byo or vercel.',
          };
        }
        const backend: SandboxBackend = backendRaw;

        let imageIn: string | null;
        if (backend === 'byo') {
          imageIn = null;
        } else if (input.image !== undefined) {
          const parsed = parseVercelSandboxImageInput(input.image);
          if (!parsed.ok) {
            return {
              ok: false as const,
              reason: 'validation' as const,
              error: parsed.error,
            };
          }
          imageIn = parsed.image;
        } else {
          imageIn = sb.image;
        }

        let tokenCiphertext: string | null = sb.tokenCiphertext;
        let tokenKekVersion = sb.tokenKekVersion;
        let baseUrl: string | null =
          input.baseUrl !== undefined
            ? input.baseUrl?.trim() || null
            : sb.baseUrl;

        if (backend === 'vercel') {
          baseUrl = null;
          tokenCiphertext = null;
        } else {
          const tokenPlain = input.token;
          if (tokenPlain != null && tokenPlain.trim() !== '') {
            const { dek, version } = await ensureTenantDek(sb.tenantId, {
              tx: tx as never,
              amk: deps.amk,
            });
            tokenKekVersion = version;
            const encrypt =
              deps.encrypt ??
              ((plaintext: string, key: Buffer) => encryptSecret(plaintext, key));
            tokenCiphertext = encrypt(tokenPlain.trim(), dek);
          }
          if (input.baseUrl !== undefined) {
            baseUrl = input.baseUrl?.trim() || null;
          }
          if (!baseUrl) {
            return {
              ok: false as const,
              reason: 'validation' as const,
              error: 'Base URL is required for BYO.',
            };
          }
          if (!isValidByoBaseUrl(baseUrl)) {
            return {
              ok: false as const,
              reason: 'validation' as const,
              error: 'Base URL must be an absolute http(s) URL.',
            };
          }
        }

        const fields = normalizeSandboxFieldsForBackend({
          backend,
          baseUrl,
          tokenCiphertext,
          image: imageIn,
        });
        const creds = assertSandboxCredentials(fields);
        if (!creds.ok) {
          return {
            ok: false as const,
            reason: 'validation' as const,
            error: creds.error,
          };
        }

        await tx
          .update(sandboxes)
          .set({
            name,
            backend: fields.backend,
            image: fields.image,
            baseUrl: fields.baseUrl,
            tokenCiphertext: fields.tokenCiphertext,
            tokenKekVersion,
          })
          .where(eq(sandboxes.id, sid));

        return { ok: true as const, sandboxId: sid };
      });
    } catch {
      return { ok: false, reason: 'db' };
    }
  };

  if (deps.db) return run(deps.db);
  if (!process.env.DATABASE_URL?.trim()) return { ok: false, reason: 'db' };
  const { db, client } = createDbConnection();
  try {
    return await run(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}
