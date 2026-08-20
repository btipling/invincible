import { createProdServices } from '../../../../../../../lib/di';
import { requireUserId, skillErrorResponse } from '../../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * GET /api/settings/skills/:id/versions/:versionId — single version with body.
 * Ownership-tenancy gated inside the store. Body returned as raw text (un-escaped).
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id, versionId } = await ctx.params;
  const sid = String(id ?? '').trim();
  const vid = String(versionId ?? '').trim();
  if (!sid || !vid) {
    return Response.json({ error: 'Missing id.', code: 'INVALID_ID' }, { status: 400 });
  }

  const result = await services.userSkills.getSkillVersion(gate.userId, sid, vid);
  if (!result.ok) {
    return skillErrorResponse(result.code, result.error);
  }
  if (!result.value) {
    return Response.json({ error: 'Version not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // Return raw body text for diff display (un-escaped wire).
  return new Response(result.value.body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
