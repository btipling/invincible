/**
 * Provider secret CRUD under tenant DEK (parent #102 / phase #103).
 * Server-only. Never log plaintext keys or ciphertext.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  createDbConnection,
  providerSecretGrants,
  providerSecretModels,
  providerSecrets,
  tenantMembers,
  type Db,
} from '../../db';
import {
  isByokProvider,
  isValidModelId,
  normalizeModelIds,
  pickMaskSource,
  validateCredentials,
  type ByokProvider,
} from '../gateway/byokProviders';
import { maskSecret } from './maskSecret';
import { encryptTenantSecret, type TenantKeyDeps } from './tenantKeys';

export type ProviderSecretsDeps = TenantKeyDeps & {
  db?: Db;
};

export type ProviderSecretErrorCode =
  | 'invalid_name'
  | 'invalid_provider'
  | 'invalid_credentials'
  | 'invalid_model_id'
  | 'duplicate_name'
  | 'not_found'
  | 'foreign_user'
  | 'unavailable';

export type ProviderSecretResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ProviderSecretErrorCode; error: string };

export type AdminProviderSecretRow = {
  id: string;
  tenantId: string;
  name: string;
  provider: ByokProvider;
  status: string;
  credentialMask: string;
  credentialKekVersion: number;
  createdAt: Date;
  updatedAt: Date;
  modelIds: string[];
  grants: { userId: string; canUse: boolean }[];
};

function trimName(name: string): string | null {
  const n = name?.trim() ?? '';
  if (n.length < 1 || n.length > 80) return null;
  return n;
}

async function withDb<T>(
  deps: ProviderSecretsDeps,
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
    const x = e as { code?: string; message?: string; cause?: unknown };
    if (x.code === '23505') return true;
    if (/unique|duplicate key/i.test(x.message ?? '')) return true;
    return walk(x.cause, depth + 1);
  };
  return walk(err);
}

export type CreateProviderSecretInput = {
  tenantId: string;
  name: string;
  provider: string;
  credentials: unknown;
};

export async function createProviderSecret(
  input: CreateProviderSecretInput,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<{ id: string }>> {
  const tenantId = input.tenantId?.trim();
  if (!tenantId) {
    return { ok: false, code: 'unavailable', error: 'tenantId is required' };
  }
  const name = trimName(input.name);
  if (!name) {
    return { ok: false, code: 'invalid_name', error: 'name must be 1–80 chars' };
  }
  if (!isByokProvider(input.provider)) {
    return { ok: false, code: 'invalid_provider', error: 'unknown provider' };
  }
  const validated = validateCredentials(input.provider, input.credentials);
  if (!validated.ok) {
    return {
      ok: false,
      code: 'invalid_credentials',
      error: validated.error,
    };
  }

  try {
    return await withDb(deps, async (db) => {
      const plain = JSON.stringify(validated.credentials);
      const { ciphertext, dekVersion } = await encryptTenantSecret(
        tenantId,
        plain,
        { ...deps, db },
      );
      try {
        const [row] = await db
          .insert(providerSecrets)
          .values({
            tenantId,
            name,
            provider: input.provider,
            credentialCiphertext: ciphertext,
            credentialKekVersion: dekVersion,
            status: 'active',
          })
          .returning({ id: providerSecrets.id });
        return { ok: true, value: { id: row.id } };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return {
            ok: false,
            code: 'duplicate_name',
            error: 'name already exists for tenant',
          };
        }
        throw err;
      }
    });
  } catch {
    return { ok: false, code: 'unavailable', error: 'could not create secret' };
  }
}

export type UpdateProviderSecretInput = {
  secretId: string;
  /** Caller's tenant — mutations fail as not_found when secret is outside this tenant. */
  tenantId: string;
  /** Optional new display name */
  name?: string;
  /** Optional credential replace */
  credentials?: unknown;
  status?: 'active' | 'disabled';
};

export async function updateProviderSecret(
  input: UpdateProviderSecretInput,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<{ id: string }>> {
  const secretId = input.secretId?.trim();
  const tenantId = input.tenantId?.trim();
  if (!secretId) {
    return { ok: false, code: 'not_found', error: 'secret not found' };
  }
  if (!tenantId) {
    return { ok: false, code: 'unavailable', error: 'tenantId is required' };
  }

  try {
    return await withDb(deps, async (db) => {
      const existing = await db
        .select()
        .from(providerSecrets)
        .where(
          and(
            eq(providerSecrets.id, secretId),
            eq(providerSecrets.tenantId, tenantId),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (!row) {
        return { ok: false, code: 'not_found', error: 'secret not found' };
      }

      const patch: {
        name?: string;
        credentialCiphertext?: string;
        credentialKekVersion?: number;
        status?: string;
        updatedAt: Date;
      } = { updatedAt: new Date() };

      if (input.name !== undefined) {
        const name = trimName(input.name);
        if (!name) {
          return {
            ok: false,
            code: 'invalid_name',
            error: 'name must be 1–80 chars',
          };
        }
        patch.name = name;
      }

      if (input.status !== undefined) {
        if (input.status !== 'active' && input.status !== 'disabled') {
          return {
            ok: false,
            code: 'unavailable',
            error: 'invalid status',
          };
        }
        patch.status = input.status;
      }

      if (input.credentials !== undefined) {
        if (!isByokProvider(row.provider)) {
          return {
            ok: false,
            code: 'invalid_provider',
            error: 'unknown provider',
          };
        }
        const validated = validateCredentials(row.provider, input.credentials);
        if (!validated.ok) {
          return {
            ok: false,
            code: 'invalid_credentials',
            error: validated.error,
          };
        }
        const plain = JSON.stringify(validated.credentials);
        const { ciphertext, dekVersion } = await encryptTenantSecret(
          row.tenantId,
          plain,
          { ...deps, db },
        );
        patch.credentialCiphertext = ciphertext;
        patch.credentialKekVersion = dekVersion;
      }

      try {
        await db
          .update(providerSecrets)
          .set(patch)
          .where(
            and(
              eq(providerSecrets.id, secretId),
              eq(providerSecrets.tenantId, tenantId),
            ),
          );
      } catch (err) {
        if (isUniqueViolation(err)) {
          return {
            ok: false,
            code: 'duplicate_name',
            error: 'name already exists for tenant',
          };
        }
        throw err;
      }
      return { ok: true, value: { id: secretId } };
    });
  } catch {
    return { ok: false, code: 'unavailable', error: 'could not update secret' };
  }
}

export async function disableProviderSecret(
  secretId: string,
  tenantId: string,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<{ id: string }>> {
  return updateProviderSecret(
    { secretId, tenantId, status: 'disabled' },
    deps,
  );
}

export async function setProviderSecretModels(
  secretId: string,
  modelIds: string[],
  tenantId: string,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<{ modelIds: string[] }>> {
  const id = secretId?.trim();
  const tid = tenantId?.trim();
  if (!id) {
    return { ok: false, code: 'not_found', error: 'secret not found' };
  }
  if (!tid) {
    return { ok: false, code: 'unavailable', error: 'tenantId is required' };
  }
  try {
    return await withDb(deps, async (db) => {
      const existing = await db
        .select({
          id: providerSecrets.id,
          provider: providerSecrets.provider,
        })
        .from(providerSecrets)
        .where(
          and(eq(providerSecrets.id, id), eq(providerSecrets.tenantId, tid)),
        )
        .limit(1);
      if (!existing[0]) {
        return { ok: false, code: 'not_found', error: 'secret not found' };
      }

      // Bare names (e.g. grok-4.5) → provider/model for Gateway (xai/grok-4.5).
      const unique = normalizeModelIds(modelIds, existing[0].provider);
      for (const mid of unique) {
        if (!isValidModelId(mid)) {
          return {
            ok: false,
            code: 'invalid_model_id',
            error: `invalid model_id: ${mid} (use provider/model, e.g. xai/grok-4.5)`,
          };
        }
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(providerSecretModels)
          .where(eq(providerSecretModels.secretId, id));
        if (unique.length > 0) {
          await tx.insert(providerSecretModels).values(
            unique.map((modelId) => ({ secretId: id, modelId })),
          );
        }
        await tx
          .update(providerSecrets)
          .set({ updatedAt: new Date() })
          .where(
            and(eq(providerSecrets.id, id), eq(providerSecrets.tenantId, tid)),
          );
      });

      return { ok: true, value: { modelIds: unique } };
    });
  } catch {
    return { ok: false, code: 'unavailable', error: 'could not set models' };
  }
}

export type GrantInput = { userId: string; canUse: boolean };

/**
 * Replace all grants for a secret. Rejects if any userId is not a
 * tenant_member of the secret's tenant (no partial write).
 */
export async function setProviderSecretGrants(
  secretId: string,
  grants: GrantInput[],
  tenantId: string,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<{ grants: GrantInput[] }>> {
  const id = secretId?.trim();
  const tid = tenantId?.trim();
  if (!id) {
    return { ok: false, code: 'not_found', error: 'secret not found' };
  }
  if (!tid) {
    return { ok: false, code: 'unavailable', error: 'tenantId is required' };
  }

  // de-dupe by userId (last wins)
  const byUser = new Map<string, boolean>();
  for (const g of grants) {
    const uid = g.userId?.trim();
    if (!uid) {
      return { ok: false, code: 'foreign_user', error: 'userId is required' };
    }
    byUser.set(uid, Boolean(g.canUse));
  }
  const normalized = [...byUser.entries()].map(([userId, canUse]) => ({
    userId,
    canUse,
  }));

  try {
    return await withDb(deps, async (db) => {
      const secrets = await db
        .select({
          id: providerSecrets.id,
          tenantId: providerSecrets.tenantId,
        })
        .from(providerSecrets)
        .where(
          and(eq(providerSecrets.id, id), eq(providerSecrets.tenantId, tid)),
        )
        .limit(1);
      const secret = secrets[0];
      if (!secret) {
        return { ok: false, code: 'not_found', error: 'secret not found' };
      }

      if (normalized.length > 0) {
        const userIds = normalized.map((g) => g.userId);
        const members = await db
          .select({ userId: tenantMembers.userId })
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.tenantId, secret.tenantId),
              inArray(tenantMembers.userId, userIds),
            ),
          );
        const memberSet = new Set(members.map((m) => m.userId));
        for (const uid of userIds) {
          if (!memberSet.has(uid)) {
            return {
              ok: false,
              code: 'foreign_user',
              error: 'user is not a tenant member',
            };
          }
        }
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(providerSecretGrants)
          .where(eq(providerSecretGrants.secretId, id));
        if (normalized.length > 0) {
          await tx.insert(providerSecretGrants).values(
            normalized.map((g) => ({
              secretId: id,
              userId: g.userId,
              canUse: g.canUse,
            })),
          );
        }
        await tx
          .update(providerSecrets)
          .set({ updatedAt: new Date() })
          .where(
            and(eq(providerSecrets.id, id), eq(providerSecrets.tenantId, tid)),
          );
      });

      return { ok: true, value: { grants: normalized } };
    });
  } catch {
    return { ok: false, code: 'unavailable', error: 'could not set grants' };
  }
}

/**
 * List secrets for a tenant (admin). Returns mask only — never ciphertext.
 * Decrypts under DEK solely to build mask; plaintext discarded.
 */
export async function listProviderSecretsForAdmin(
  tenantId: string,
  deps: ProviderSecretsDeps = {},
): Promise<ProviderSecretResult<AdminProviderSecretRow[]>> {
  const tid = tenantId?.trim();
  if (!tid) {
    return { ok: false, code: 'unavailable', error: 'tenantId is required' };
  }

  try {
    return await withDb(deps, async (db) => {
      const { decryptTenantSecret } = await import('./tenantKeys');
      const rows = await db
        .select()
        .from(providerSecrets)
        .where(eq(providerSecrets.tenantId, tid));

      const result: AdminProviderSecretRow[] = [];
      for (const row of rows) {
        let credentialMask = '********';
        try {
          const plain = await decryptTenantSecret(
            tid,
            row.credentialCiphertext,
            { ...deps, db },
          );
          const parsed = JSON.parse(plain) as Record<string, unknown>;
          credentialMask = maskSecret(pickMaskSource(parsed));
        } catch {
          credentialMask = '********';
        }

        const models = await db
          .select({ modelId: providerSecretModels.modelId })
          .from(providerSecretModels)
          .where(eq(providerSecretModels.secretId, row.id));
        const grants = await db
          .select({
            userId: providerSecretGrants.userId,
            canUse: providerSecretGrants.canUse,
          })
          .from(providerSecretGrants)
          .where(eq(providerSecretGrants.secretId, row.id));

        result.push({
          id: row.id,
          tenantId: row.tenantId,
          name: row.name,
          provider: row.provider as ByokProvider,
          status: row.status,
          credentialMask,
          credentialKekVersion: row.credentialKekVersion,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          modelIds: models.map((m) => m.modelId).sort(),
          grants: grants.map((g) => ({
            userId: g.userId,
            canUse: g.canUse,
          })),
        });
      }

      result.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, value: result };
    });
  } catch {
    return { ok: false, code: 'unavailable', error: 'could not list secrets' };
  }
}
