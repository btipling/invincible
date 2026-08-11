import { listModelsForUser } from '../../../lib/tenancy/resolveInference';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';

export type ModelCatalogEntry = {
  id: string;
  label: string;
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
    const ids = await listModelsForUser(userId);
    const models: ModelCatalogEntry[] = ids.map((id) => ({
      id,
      label: shortLabel(id),
    }));
    return Response.json({ models });
  } catch {
    return Response.json(
      { error: 'Could not load model catalog.' },
      { status: 503 },
    );
  }
}
