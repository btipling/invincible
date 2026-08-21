import { createProdServices } from '../../../../../../lib/di';
import { requireUserId, personaErrorResponse } from '../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/settings/personas/:id/versions — list version summaries (no body),
 * newest first. Ownership-tenancy gated inside the store (plan #726).
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const id2 = String(id ?? '').trim();
  if (!id2) {
    return Response.json({ error: 'Missing persona id.', code: 'INVALID_ID' }, { status: 400 });
  }

  const result = await services.userPersonas.listPersonaVersions(gate.userId, id2);
  if (!result.ok) {
    return personaErrorResponse(result.code, result.error);
  }

  return Response.json({ ok: true, versions: result.value }, { status: 200 });
}
