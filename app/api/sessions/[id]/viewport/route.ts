/** Read-only, head-only display view. Never a canonical transcript or model seed. */
import { createProdServices } from '../../../../../lib/di';
import { requireSessionUser } from '../../../../../lib/tenancy/session';
import { resolveSessionStore, sessionKeyFor } from '../../../../../lib/tenancy/harnessSessionsRedis';
import { isEnvelopeStore } from '../../../../../lib/sessions/sessionStore';
import { readViewportHead, emptyViewport } from '../../../../../lib/sessions/viewportRead';
import { isRedisSafeOpaqueId, sanitizeTurnRunId, VIEWPORT_RECOVERY_MAX_MS } from '../../../../../lib/sessionCloudCaps';
import { viewportWait } from '../../../../../lib/workflows/viewportRunReader';

const services = createProdServices();
export const runtime = 'nodejs';
/** JSON 5 s recovery budget — not a long-lived SSE attach. */
export const maxDuration = 15;
const headers = { 'Cache-Control': 'private, no-store, no-transform' };

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser();
  if (!auth.ok) return auth.response;
  if (!auth.user?.id) return Response.json({ error: 'Authentication required.' }, { status: 401 });
  const { id } = await ctx.params;
  if (!isRedisSafeOpaqueId(id)) return Response.json({ error: 'Invalid session id.' }, { status: 400 });
  const q = new URL(req.url).searchParams;
  const rawRun = q.get('runId');
  if (q.getAll('runId').length > 1 || (rawRun !== null && sanitizeTurnRunId(rawRun) !== rawRun) ||
    [...q.keys()].some(k => k !== 'runId')) return Response.json({ error: 'Invalid viewport query.' }, { status: 400 });
  try {
    const tenant = await services.harnessSessionsRedis.resolveTenantIdForUser(auth.user.id);
    const stored = await resolveSessionStore();
    if (!tenant.ok || !stored.ok || !isEnvelopeStore(stored.value)) throw new Error('Store unavailable');
    const scope = { tenantId: tenant.value, userId: auth.user.id, sessionId: id };
    const key = sessionKeyFor(scope.tenantId, scope.userId, id);
    const envelope = await stored.value.readEnvelope(key);
    if (!envelope || (rawRun !== null && envelope.meta.turnRunId !== rawRun))
      return Response.json({ error: 'Session not found.' }, { status: 404 });
    const head = await viewportWait((async () => {
      try { return await readViewportHead({ scope, meta: envelope.meta,
        blob: services.createBlobTranscriptStore(), signal: req.signal }); }
      catch { return emptyViewport(id, envelope.meta); }
    })(), VIEWPORT_RECOVERY_MAX_MS, req.signal).catch(() => emptyViewport(id, envelope.meta));
    return Response.json(head, { headers });
  } catch {
    return Response.json({ error: 'Viewport store unavailable.' }, { status: 503, headers });
  }
}
