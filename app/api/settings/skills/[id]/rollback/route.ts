import { revalidatePath } from 'next/cache';
import { createProdServices } from '../../../../../../lib/di';
import { requireUserId, skillErrorResponse } from '../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/settings/skills/:id/rollback — roll back a skill to a specific
 * version. The request body is JSON `{ versionId }`. Copies the version's body
 * into user_skills.body + inserts a new version row (rollback IS versioned).
 * Ownership-tenancy gated inside the store.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const sid = String(id ?? '').trim();
  if (!sid) {
    return Response.json({ error: 'Missing skill id.', code: 'INVALID_ID' }, { status: 400 });
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

  const result = await services.userSkills.rollbackSkill(gate.userId, sid, vid);
  if (!result.ok) {
    return skillErrorResponse(result.code, result.error);
  }

  try {
    revalidatePath('/settings');
    revalidatePath('/settings/skills');
  } catch {
    // Best-effort.
  }

  return Response.json({ ok: true, id: result.value.id }, { status: 200 });
}
