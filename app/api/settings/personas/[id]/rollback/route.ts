import { revalidatePath } from 'next/cache';
import { createProdServices } from '../../../../../../lib/di';
import { requireUserId, personaErrorResponse } from '../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/settings/personas/:id/rollback — roll a persona back to a specific
 * version. The request body is JSON `{ versionId }`. Copies the version's body
 * into user_personas.body + inserts a new version row (rollback IS versioned).
 * Ownership-tenancy gated inside the store (plan #726).
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const pid = String(id ?? '').trim();
  if (!pid) {
    return Response.json({ error: 'Missing persona id.', code: 'INVALID_ID' }, { status: 400 });
  }

  let body: { versionId?: string };
  try {
    body = (await req.json()) as { versionId?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON body.', code: 'INVALID_BODY' }, { status: 400 });
  }
  const vid = String(body.versionId ?? '').trim();
  if (!vid) {
    return Response.json({ error: 'Missing versionId.', code: 'INVALID_ID' }, { status: 400 });
  }

  const result = await services.userPersonas.rollbackPersona(gate.userId, pid, vid);
  if (!result.ok) {
    return personaErrorResponse(result.code, result.error);
  }

  try {
    revalidatePath('/settings');
    revalidatePath('/settings/personas');
  } catch {
    // Best-effort.
  }

  return Response.json({ ok: true, id: result.value.id }, { status: 200 });
}
