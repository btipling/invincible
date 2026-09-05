import { createProdServices } from '../../../lib/di';
import {
  getJoinedEffortMap,
  getJoinedWindowMap,
} from '../../../lib/gateway/modelCatalog';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';

const { resolveInference } = createProdServices();

export type ModelCatalogEntry = {
  id: string;
  label: string;
  /** Joined catalog `type: effort` values (empty when unpublished). */
  reasoningOptions: string[];
  /**
   * The model's published context window in tokens (plan #944). Undefined
   * when neither catalog source publishes one — the fold trim falls back to
   * the conservative default; never a fabricated window.
   */
  contextWindow?: number;
};

function shortLabel(modelId: string): string {
  const i = modelId.lastIndexOf('/');
  if (i >= 0 && i < modelId.length - 1) return modelId.slice(i + 1);
  return modelId;
}

/**
 * GET /api/models — session-gated model catalog for the harness picker.
 * Multi-tenant only: granted models only (never credentials, never a single env model).
 */
export async function GET(): Promise<Response> {
  // Fail closed: always require a session. The middleware already gates /api/models
  // (login wall); requiring a session here too keeps the route fail-closed if
  // middleware coverage ever drifts.
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  try {
    const ids = await resolveInference.listModelsForUser(userId);
    // Catalog fail-open lives in getJoinedEffortMap (never throws). Extra
    // try keeps a 503 as grants-fail only if that contract ever drifts.
    let effortMap: Map<string, string[]> = new Map();
    let windowMap: Map<string, number> = new Map();
    try {
      [effortMap, windowMap] = await Promise.all([
        getJoinedEffortMap(),
        getJoinedWindowMap(),
      ]);
    } catch {
      effortMap = new Map();
      windowMap = new Map();
    }
    const models: ModelCatalogEntry[] = ids.map((id) => {
      const window = windowMap.get(id);
      return {
        id,
        label: shortLabel(id),
        reasoningOptions: effortMap.get(id) ?? [],
        // Omitted when unpublished — never a fabricated window (plan #944).
        ...(window !== undefined ? { contextWindow: window } : {}),
      };
    });
    return Response.json({ models });
  } catch {
    return Response.json(
      { error: 'Could not load model catalog.' },
      { status: 503 },
    );
  }
}
