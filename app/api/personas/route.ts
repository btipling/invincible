import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';

const services = createProdServices();

/**
 * GET /api/personas — signed-in user's persona summaries for the harness picker.
 * Returns only non-secret summaries `{id,name,slug,isDefault,updatedAt}` — NEVER
 * the persona body (body stays server-side; Phase 3 resolves it by id for
 * injection). Auth: middleware matcher + in-route `requireSessionUser`.
 */
export async function GET(): Promise<Response> {
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
    const result = await services.userPersonas.listUserPersonas(userId);
    if (!result.ok) {
      if (result.code === 'unavailable') {
        return Response.json(
          { error: 'Could not list personas.' },
          { status: 503 },
        );
      }
      return Response.json({ error: result.error }, { status: 403 });
    }
    return Response.json({ personas: result.value });
  } catch {
    return Response.json({ error: 'Could not list personas.' }, { status: 503 });
  }
}
