import { createProdServices } from '../../../../../../../lib/di';
import { requireUserId, personaErrorResponse } from '../../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * GET /api/settings/personas/:id/versions/:versionId — single version with body.
 * Ownership-tenancy gated inside the store (plan #726). Body returned as raw
 * text (un-escaped), mirroring the skill version route.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id, versionId } = await ctx.params;
  const pid = String(id ?? '').trim();
  const vid = String(versionId ?? '').trim();
  if (!pid || !vid) {
    return Response.json({ error: 'Missing id.', code: 'INVALID_ID' }, { status: 400 });
  }

  const result = await services.userPersonas.getPersonaVersion(gate.userId, pid, vid);
  if (!result.ok) {
    return personaErrorResponse(result.code, result.error);
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
