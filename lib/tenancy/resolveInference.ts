/**
 * Catalog + request-scoped BYOK resolve (parent #102 / phase #103).
 * Server-only. No HTTP. Never log credentials or ciphertext.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  providerSecretGrants,
  providerSecretModels,
  providerSecrets,
  tenantMembers,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import {
  byokGatewayKey,
  collectRedactableSecrets,
  isByokProvider,
  isValidModelId,
  type ByokProvider,
} from '../gateway/byokProviders';
import { decryptTenantSecret, type TenantKeyDeps } from './tenantKeys';

export type ResolveInferenceDeps = TenantKeyDeps & {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type ResolveByokSuccess = {
  ok: true;
  modelId: string;
  provider: ByokProvider;
  credentials: Record<string, unknown>;
  only: [string];
  byok: Record<string, [Record<string, unknown>]>;
  secretId: string;
  secretsToRedact: string[];
};

export type ResolveByokFailure = {
  ok: false;
  reason: 'forbidden' | 'unavailable' | 'model_invalid';
};

export type ResolveByokResult = ResolveByokSuccess | ResolveByokFailure;

async function withDb<T>(
  deps: ResolveInferenceDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withConnection(deps, fn);
}

/**
 * Distinct model ids the user may use, sorted model_id ASC (stable default).
 * Empty when no sole membership or no grants. DB/query errors propagate
 * (callers that need fail-closed HTTP map catch → unavailable).
 */
export async function listModelsForUser(
  userId: string,
  deps: ResolveInferenceDeps = {},
): Promise<string[]> {
  const id = userId?.trim();
  if (!id) return [];

  return await withDb(deps, async (db) => {
    const memberships = await db
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, id));
    if (memberships.length !== 1) {
      return [];
    }
    const tenantId = memberships[0].tenantId;

    const rows = await db
      .select({
        modelId: providerSecretModels.modelId,
      })
      .from(providerSecretGrants)
      .innerJoin(
        providerSecrets,
        eq(providerSecretGrants.secretId, providerSecrets.id),
      )
      .innerJoin(
        providerSecretModels,
        eq(providerSecretModels.secretId, providerSecrets.id),
      )
      .where(
        and(
          eq(providerSecretGrants.userId, id),
          eq(providerSecretGrants.canUse, true),
          eq(providerSecrets.status, 'active'),
          eq(providerSecrets.tenantId, tenantId),
        ),
      );

    const set = new Set(rows.map((r) => r.modelId));
    return [...set].sort((a, b) => a.localeCompare(b));
  });
}

type Candidate = {
  secretId: string;
  provider: string;
  credentialCiphertext: string;
  createdAt: Date;
  tenantId: string;
};

/**
 * Resolve BYOK credentials for (userId, modelId).
 * Prefer provider matching model prefix; then created_at ASC; then id ASC.
 */
export async function resolveByokForModel(
  userId: string,
  modelId: string,
  deps: ResolveInferenceDeps = {},
): Promise<ResolveByokResult> {
  const uid = userId?.trim();
  const mid = modelId?.trim();
  if (!uid) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!mid || !isValidModelId(mid)) {
    return { ok: false, reason: 'model_invalid' };
  }

  try {
    return await withDb(deps, async (db) => {
      const memberships = await db
        .select({ tenantId: tenantMembers.tenantId })
        .from(tenantMembers)
        .where(eq(tenantMembers.userId, uid));
      if (memberships.length !== 1) {
        return { ok: false, reason: 'forbidden' };
      }
      const tenantId = memberships[0].tenantId;

      const rows = await db
        .select({
          secretId: providerSecrets.id,
          provider: providerSecrets.provider,
          credentialCiphertext: providerSecrets.credentialCiphertext,
          createdAt: providerSecrets.createdAt,
          tenantId: providerSecrets.tenantId,
        })
        .from(providerSecretGrants)
        .innerJoin(
          providerSecrets,
          eq(providerSecretGrants.secretId, providerSecrets.id),
        )
        .innerJoin(
          providerSecretModels,
          and(
            eq(providerSecretModels.secretId, providerSecrets.id),
            eq(providerSecretModels.modelId, mid),
          ),
        )
        .where(
          and(
            eq(providerSecretGrants.userId, uid),
            eq(providerSecretGrants.canUse, true),
            eq(providerSecrets.status, 'active'),
            eq(providerSecrets.tenantId, tenantId),
          ),
        )
        .orderBy(asc(providerSecrets.createdAt), asc(providerSecrets.id));

      if (rows.length === 0) {
        return { ok: false, reason: 'forbidden' };
      }

      const prefix = mid.split('/')[0] ?? '';
      const candidates: Candidate[] = [...rows];
      candidates.sort((a, b) => {
        const aMatch = a.provider === prefix ? 0 : 1;
        const bMatch = b.provider === prefix ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        const t = a.createdAt.getTime() - b.createdAt.getTime();
        if (t !== 0) return t;
        return a.secretId.localeCompare(b.secretId);
      });

      const chosen = candidates[0];
      if (!isByokProvider(chosen.provider)) {
        return { ok: false, reason: 'unavailable' };
      }

      let plain: string;
      try {
        plain = await decryptTenantSecret(
          chosen.tenantId,
          chosen.credentialCiphertext,
          { ...deps, db },
        );
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      let credentials: Record<string, unknown>;
      try {
        credentials = JSON.parse(plain) as Record<string, unknown>;
        if (!credentials || typeof credentials !== 'object') {
          return { ok: false, reason: 'unavailable' };
        }
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      const provider = chosen.provider;
      const key = byokGatewayKey(provider);
      return {
        ok: true,
        modelId: mid,
        provider,
        credentials,
        only: [key],
        byok: { [key]: [credentials] },
        secretId: chosen.secretId,
        secretsToRedact: collectRedactableSecrets(credentials),
      };
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createResolveInference(deps: ResolveInferenceDeps = {}) {
  return {
    listModelsForUser: (userId: string, o?: ResolveInferenceDeps) =>
      listModelsForUser(userId, { ...deps, ...o }),
    resolveByokForModel: (userId: string, modelId: string, o?: ResolveInferenceDeps) =>
      resolveByokForModel(userId, modelId, { ...deps, ...o }),
  };
}
