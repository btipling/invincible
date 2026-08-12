/**
 * GET/POST /api/sessions — id-shaped cloud multi-session surface (phase 2, #414).
 * Auth required; tenant + ownership always server-derived from the session user.
 */
import { requireSessionUser } from '../../../lib/tenancy/session';
import type { HarnessSessionRecord } from '../../../lib/sessions/sessionStore';
import {
  resolveSessionStore,
  resolveTenantIdForUser,
  sessionKeyFor,
  sessionScopeFor,
  toSessionSummary,
  unavailableResponse,
} from '../../../lib/tenancy/harnessSessionsRedis';

export const runtime = 'nodejs';

async function requireAuthedUserId(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const gate = await requireSessionUser();
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!gate.user?.id) {
    return {
      ok: false,
      response: unavailableResponse('AUTH_REQUIRED', 'Signed-in user has no id.'),
    };
  }
  return { ok: true, userId: gate.user.id };
}

async function resolveScopeFor(
  userId: string,
): Promise<
  | {
      ok: true;
      tenantId: string;
      store: import('../../../lib/sessions/sessionStore').ServerSessionStore;
    }
  | { ok: false; response: Response }
> {
  const tenant = await resolveTenantIdForUser(userId);
  if (!tenant.ok) {
    return { ok: false, response: unavailableResponse(tenant.code, tenant.error) };
  }
  const store = await resolveSessionStore();
  if (!store.ok) {
    return { ok: false, response: unavailableResponse(store.code, store.error) };
  }
  return { ok: true, tenantId: tenant.value, store: store.value };
}

function parseOptionalTitleBody(raw: string): { title?: string; error?: Response } {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: Response.json({ error: 'Invalid JSON body.', code: 'INVALID_JSON' }, { status: 400 }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      error: Response.json({ error: 'Invalid body.', code: 'INVALID_BODY' }, { status: 400 }),
    };
  }
  const o = parsed as Record<string, unknown>;
  if ('title' in o) {
    if (typeof o.title !== 'string') {
      return {
        error: Response.json({ error: 'title must be a string.', code: 'INVALID_TITLE' }, { status: 400 }),
      };
    }
    return { title: o.title };
  }
  return {};
}

/**
 * GET /api/sessions — list the caller's sessions as light summaries
 * (id/createdAt/updatedAt/title; **no transcripts**).
 */
export async function GET(): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;

  const scopeRes = await resolveScopeFor(gate.userId);
  if (!scopeRes.ok) return scopeRes.response;

  const store = scopeRes.store;
  const records = await store.list(sessionScopeFor(scopeRes.tenantId, gate.userId));
  return Response.json(records.map(toSessionSummary));
}

/**
 * POST /api/sessions — mint a new server-side UUID session (empty, `updatedAt: 0`)
 * and return it. Optional title → `meta.title`. Host's first PUT (epoch-now ≥ 0)
 * is therefore idempotent-accept, never a spurious 409.
 */
export async function POST(req: Request): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;

  const scopeRes = await resolveScopeFor(gate.userId);
  if (!scopeRes.ok) return scopeRes.response;

  const title = parseOptionalTitleBody(await req.text());
  if (title.error) return title.error;

  const id = crypto.randomUUID();
  const meta = title.title !== undefined ? { title: title.title } : {};
  const now = Date.now();
  const record: HarnessSessionRecord = {
    id,
    userId: gate.userId,
    tenantId: scopeRes.tenantId,
    createdAt: now,
    updatedAt: 0,
    messages: [],
    meta,
  };

  const put = await scopeRes.store.put(
    sessionKeyFor(scopeRes.tenantId, gate.userId, id),
    record,
  );
  const stored = put.status === 'stored' ? put.record : put.server;
  return Response.json(stored);
}
