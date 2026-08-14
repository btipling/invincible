import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';

const services = createProdServices();

/**
 * GET /api/skills — signed-in user's skill summaries for discovery (phase 1,
 * parent #495 / issue #498). Returns ONLY non-secret summaries
 * `{id,name,slug,description,updatedAt}` — NEVER the skill body. Body stays
 * server-side and is resolved by slug via the store (`getSkillBySlug`) for
 * phase-3 injection; there is deliberately no client-facing body route this
 * phase. Auth: middleware matcher + in-route `requireSessionUser`.
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
    const result = await services.userSkills.listUserSkills(userId);
    if (!result.ok) {
      if (result.code === 'unavailable') {
        return Response.json(
          { error: 'Could not list skills.' },
          { status: 503 },
        );
      }
      return Response.json({ error: result.error }, { status: 403 });
    }
    return Response.json({ skills: result.value });
  } catch {
    return Response.json({ error: 'Could not list skills.' }, { status: 503 });
  }
}
