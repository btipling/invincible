/**
 * GET/PUT/DELETE /api/sessions/:id — id-shaped cloud multi-session CRUD (phase 2, #414).
 * Auth required; write key always derived from the path `:id` + the authed user's
 * tenant. Body `id` must equal the path `:id` (else 400); never trust body ownership.
 */
import { requireSessionUser } from '../../../../lib/tenancy/session';
import { HARNESS_SESSION_MAX_BODY_BYTES } from '../../../../lib/sessionCloudCaps';
import {
  type SessionRecordKey,
  validateSessionRecord,
} from '../../../../lib/sessions/sessionStore';
import {
  resolveSessionStore,
  resolveTenantIdForUser,
  sessionKeyFor,
  unavailableResponse,
} from '../../../../lib/tenancy/harnessSessionsRedis';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

async function requireScopeFor(
  userId: string,
): Promise<
  | {
      ok: true;
      tenantId: string;
      store: import('../../../../lib/sessions/sessionStore').ServerSessionStore;
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

type GuardResult = { ok: true; userId: string } | { ok: false; response: Response };

async function authedUserGate(): Promise<GuardResult> {
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

/** GET /api/sessions/:id — full record, or 404 (other/nonexistent id → 404, no existence leak). */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) {
    return Response.json({ error: 'id required.', code: 'INVALID_ID' }, { status: 400 });
  }

  const scope = await requireScopeFor(gate.userId);
  if (!scope.ok) return scope.response;

  const key: SessionRecordKey = sessionKeyFor(scope.tenantId, gate.userId, id);
  const record = await scope.store.get(key);
  if (!record) {
    return Response.json({ error: 'Session not found.', code: 'NOT_FOUND' }, { status: 404 });
  }
  return Response.json(record);
}

/**
 * PUT /api/sessions/:id — LWW upsert keyed by path `:id`.
 * Body `{ id, updatedAt, messages, meta? }`; body `id` must equal path `:id`
 * (else 400). Stale `updatedAt <` stored → 409 + server record. Equal ≥ → write.
 */
export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) {
    return Response.json({ error: 'id required.', code: 'INVALID_ID' }, { status: 400 });
  }

  // Reuse the legacy route's body-size guard (content-length + raw bytes).
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > HARNESS_SESSION_MAX_BODY_BYTES) {
      return Response.json({ error: 'Request body too large.', code: 'BODY_TOO_LARGE' }, { status: 413 });
    }
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > HARNESS_SESSION_MAX_BODY_BYTES) {
    return Response.json({ error: 'Request body too large.', code: 'BODY_TOO_LARGE' }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Invalid JSON body.', code: 'INVALID_JSON' }, { status: 400 });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Response.json({ error: 'Invalid body.', code: 'INVALID_BODY' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  // Path-`:id` write-key rule (parent #411 lock): the record key + ownership are
  // derived from the URL resource; an incoming body id must agree with the path.
  if (body.id !== id) {
    return Response.json(
      { error: 'body id must match the path id.', code: 'ID_MISMATCH' },
      { status: 400 },
    );
  }

  const scope = await requireScopeFor(gate.userId);
  if (!scope.ok) return scope.response;

  // `validateSessionRecord` (Phase 1) re-validates id / updatedAt / messages caps and
  // the schema-typed reserved `meta`; candidate is untyped so a malformed field fails
  // validation (400) rather than being asserted into a record shape here.
  const candidate = {
    id,
    tenantId: scope.tenantId,
    userId: gate.userId,
    createdAt: 0, // create-preserve; store upsert keeps the stored `createdAt`
    updatedAt: body.updatedAt,
    messages: body.messages,
    meta: body.meta,
  };
  const validated = validateSessionRecord(candidate);
  if (!validated.ok) {
    return Response.json(
      { error: validated.error, code: validated.code.toUpperCase() },
      { status: 400 },
    );
  }

  const key: SessionRecordKey = sessionKeyFor(scope.tenantId, gate.userId, id);
  const result = await scope.store.put(key, validated.value);
  if (result.status === 'conflict') {
    return Response.json(result.server, { status: 409 });
  }
  return Response.json(result.record);
}

/** DELETE /api/sessions/:id — delete ONE, idempotent 204 (others untouched). */
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  if (!id?.trim()) {
    return Response.json({ error: 'id required.', code: 'INVALID_ID' }, { status: 400 });
  }

  const scope = await requireScopeFor(gate.userId);
  if (!scope.ok) return scope.response;

  await scope.store.remove(sessionKeyFor(scope.tenantId, gate.userId, id));
  return new Response(null, { status: 204 });
}
