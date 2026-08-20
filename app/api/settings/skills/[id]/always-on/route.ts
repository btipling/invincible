/**
 * POST /api/settings/skills/[id]/always-on — toggle is_always_on (plan #720 phase 2).
 * Body: { value: boolean }. Author-as-user: resolves caller via requireSessionUser,
 * delegates to userSkills.setAlwaysOn. Cap enforcement is inside setAlwaysOn.
 */
import { createProdServices } from '../../../../../../lib/di';
import { requireSessionUser } from '../../../../../../lib/tenancy/session';

export const runtime = 'nodejs';

const services = createProdServices();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;

  const userId = sessionGate.user?.id;
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return Response.json({ error: 'Missing skill id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('value' in body) ||
    typeof (body as { value: unknown }).value !== 'boolean'
  ) {
    return Response.json(
      { error: 'Body must be { value: boolean }' },
      { status: 400 },
    );
  }

  const value = (body as { value: boolean }).value;

  const result = await services.userSkills.setAlwaysOn(userId, id, value);
  if (!result.ok) {
    if (result.code === 'not_found') {
      return Response.json({ error: result.error }, { status: 404 });
    }
    if (result.code === 'limit_reached') {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ error: result.error }, { status: 500 });
  }

  return Response.json({ ok: true, id: result.value.id, isAlwaysOn: value });
}
