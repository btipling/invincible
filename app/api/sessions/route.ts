/**
 * GET/POST /api/sessions — id-shaped cloud multi-session surface (phase 2, #414).
 * Auth required; tenant + ownership always server-derived from the session user.
 */
import { requireSessionUser } from '../../../lib/tenancy/session';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';
import { isRedisSafeOpaqueId } from '../../../lib/sessionCloudCaps';
import {
  type HarnessSessionRecord,
  validateSessionRecord,
} from '../../../lib/sessions/sessionStore';
import { createProdServices } from '../../../lib/di';
import {
  guardStore,
  resolveSessionStore,
  sessionKeyFor,
  sessionScopeFor,
  toSessionSummary,
  unavailableResponse,
} from '../../../lib/tenancy/harnessSessionsRedis';

const { harnessSessionsRedis } = createProdServices();

export const runtime = 'nodejs';

async function requireAuthedUserId(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const gate = await requireSessionUser();
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!gate.user?.id) {
    // Tenant gate succeeded but no user id — mirror the legacy /api/session 401 so
    // clients re-auth, not a 503 "store down".
    return { ok: false, response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }) };
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
  const tenant = await harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenant.ok) {
    return { ok: false, response: unavailableResponse(tenant.code, tenant.error) };
  }
  const store = await resolveSessionStore();
  if (!store.ok) {
    return { ok: false, response: unavailableResponse(store.code, store.error) };
  }
  return { ok: true, tenantId: tenant.value, store: store.value };
}

function parseOptionalMintBody(
  raw: string,
): { title?: string; personaId?: string; error?: Response } {
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
  const out: { title?: string; personaId?: string } = {};
  if ('title' in o) {
    if (typeof o.title !== 'string') {
      return {
        error: Response.json({ error: 'title must be a string.', code: 'INVALID_TITLE' }, { status: 400 }),
      };
    }
    out.title = o.title;
  }
  if ('personaId' in o) {
    // Optional persona binding (phase 3 #488): Redis-safe opaque, mirrors the
    // agent-body + session-meta `personaId` rule. Stored as `meta.personaId`;
    // the snapshot is resolved lazily on the first `/api/agent` turn.
    if (o.personaId !== undefined && o.personaId !== null) {
      if (!isRedisSafeOpaqueId(o.personaId)) {
        return {
          error: Response.json(
            { error: 'personaId must be a Redis-safe opaque id.', code: 'INVALID_PERSONA_ID' },
            { status: 400 },
          ),
        };
      }
      out.personaId = o.personaId;
    }
  }
  return out;
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
  // Guard store I/O: an unreachable/poisoned Redis rejects here and becomes a clean
  // 503 SESSION_STORE_UNAVAILABLE, never an uncaught 500 (adversarial L1/L6).
  const listing = await guardStore(() =>
    store.list(sessionScopeFor(scopeRes.tenantId, gate.userId)),
  );
  if (!listing.ok) return listing.response;
  return Response.json(listing.value.map(toSessionSummary));
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

  const mint = parseOptionalMintBody(await req.text());
  if (mint.error) return mint.error;

  const id = crypto.randomUUID();
  const meta: import('../../../lib/sessions/sessionStore').HarnessSessionMeta = {};
  if (mint.title !== undefined) meta.title = mint.title;
  // Optional persona binding (phase 3 #488): stored as `meta.personaId`; the
  // snapshot is resolved lazily on the first `/api/agent` turn.
  if (mint.personaId !== undefined) meta.personaId = mint.personaId;
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

  // Validate the minted record before persisting (same Phase 1 validator PUT uses), so
  // an oversize / invalid `meta` (e.g. a huge title) returns 400 INVALID_META instead of
  // the store's throwing `assertValidSessionRecord` surfacing as a 500 (adversarial L1).
  const validated = validateSessionRecord(record);
  if (!validated.ok) {
    return Response.json(
      { error: validated.error, code: validated.code.toUpperCase() },
      { status: 400 },
    );
  }

  const put = await guardStore(() =>
    scopeRes.store.put(
      sessionKeyFor(scopeRes.tenantId, gate.userId, id),
      validated.value,
    ),
  );
  if (!put.ok) return put.response;
  const stored = put.value.status === 'stored' ? put.value.record : put.value.server;
  return Response.json(stored);
}
