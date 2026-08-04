/**
 * Request-scoped BYOK resolve for chat/agent routes (phase 2 / #104).
 * Server-only.
 */
import {
  listModelsForUser,
  resolveByokForModel,
  type ResolveByokResult,
  type ResolveInferenceDeps,
} from './resolveInference';

export type RequestByokSuccess = {
  ok: true;
  modelId: string;
  provider: string;
  credentials: Record<string, unknown>;
  only: [string];
  byok: Record<string, [Record<string, unknown>]>;
  secretId: string;
  secretsToRedact: string[];
};

export type RequestByokFailure = {
  ok: false;
  reason: 'forbidden' | 'unavailable' | 'model_invalid';
};

export type RequestByokResult = RequestByokSuccess | RequestByokFailure;

/**
 * Resolve model + BYOK for a tenancy-on request.
 * - If modelId provided: validate via resolveByokForModel.
 * - If omitted: first entry from listModelsForUser (stable ASC); empty → forbidden.
 */
export async function resolveByokForRequest(
  userId: string,
  modelId: string | undefined,
  deps: ResolveInferenceDeps = {},
): Promise<RequestByokResult> {
  const uid = userId?.trim();
  if (!uid) {
    return { ok: false, reason: 'forbidden' };
  }

  let effective = modelId?.trim();
  if (!effective) {
    const catalog = await listModelsForUser(uid, deps);
    if (catalog.length === 0) {
      return { ok: false, reason: 'forbidden' };
    }
    effective = catalog[0];
  }

  const resolved: ResolveByokResult = await resolveByokForModel(uid, effective, deps);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  return {
    ok: true,
    modelId: resolved.modelId,
    provider: resolved.provider,
    credentials: resolved.credentials,
    only: resolved.only,
    byok: resolved.byok,
    secretId: resolved.secretId,
    secretsToRedact: resolved.secretsToRedact,
  };
}
