/**
 * Phase 0 (#515) — `/api/sessions/:id/envelope` — the small, always-fetchable envelope
 * for the Blob transcript carrier.
 *
 * - `PUT` — upsert the envelope (ownership + `updatedAt` LWW + reserved `meta` incl.
 *   `meta.transcriptPointer`). Never carries the transcript (that lives in Blob objects
 *   pointed to by the pointer). Stale `updatedAt <` stored → 409 + server envelope;
 *   equal ≥ → write. `createdAt` preserved by the store.
 * - `GET` — read the envelope (+ a server-signed read URL when `meta.transcriptPointer`
 *   is set), so the host can fetch the needed Blob page directly. This is the read-window
 *   surface; the legacy whole-record `GET /api/sessions/:id` stays for roll-forward while
 *   old blobs stay small.
 */
import { requireSessionUser } from '../../../../../lib/tenancy/session';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';
import {
  type SessionRecordKey,
  type SessionEnvelopeInput,
  isEnvelopeStore,
  validateSessionEnvelope,
} from '../../../../../lib/sessions/sessionStore';
import { isObjectIdBoundTo } from '../../../../../lib/sessions/blobStore';
import { isRedisSafeOpaqueId } from '../../../../../lib/sessionCloudCaps';
import { createProdServices } from '../../../../../lib/di';
import {
  guardStore,
  resolveSessionStore,
  sessionKeyFor,
  unavailableResponse,
} from '../../../../../lib/tenancy/harnessSessionsRedis';
import { resolveBlobStore } from '../../../../../lib/tenancy/harnessSessionsRedis';

const { harnessSessionsRedis } = createProdServices();

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

async function authedUserGate(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const gate = await requireSessionUser();
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!gate.user?.id) {
    return { ok: false, response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }) };
  }
  return { ok: true, userId: gate.user.id };
}

function invalidIdResponse(id: string | undefined): Response | null {
  if (!id?.trim()) {
    return Response.json({ error: 'id required.', code: 'INVALID_ID' }, { status: 400 });
  }
  if (!isRedisSafeOpaqueId(id)) {
    return Response.json(
      { error: 'id must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).', code: 'INVALID_ID' },
      { status: 400 },
    );
  }
  return null;
}

async function requireScopeFor(
  userId: string,
): Promise<
  | {
      ok: true;
      tenantId: string;
      store: import('../../../../../lib/sessions/sessionStore').ServerSessionStore;
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

/** GET /api/sessions/:id/envelope — small envelope + signed read URL (read window). */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const badId = invalidIdResponse(id);
  if (badId) return badId;

  const scope = await requireScopeFor(gate.userId);
  if (!scope.ok) return scope.response;

  const store = scope.store;
  if (!isEnvelopeStore(store)) {
    // Envelope seam unavailable on this store → the legacy whole-record GET remains
    // the roll-forward read path (phase 0 only runs on stores that implement the seam).
    return unavailableResponse('ENVELOPE_STORE_UNAVAILABLE', 'envelope store unavailable');
  }

  const key: SessionRecordKey = sessionKeyFor(scope.tenantId, gate.userId, id);
  const got = await guardStore(() => store.readEnvelope(key));
  if (!got.ok) return got.response;
  if (!got.value) {
    return Response.json({ error: 'Session not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // Include a server-signed read URL when the envelope carries a transcript pointer,
  // so the host pages from Blob instead of a whole-record Function GET.
  let readUrl: string | null = null;
  const pointer = got.value.meta.transcriptPointer;
  if (typeof pointer === 'string' && pointer) {
    // Defense in depth (reader's Major L2): only sign a read URL for an object whose
    // binding prefix matches THIS session. The envelope pointer is PUT-gated to be
    // session-bound today, but this guarantees a planted pointer never yields a signed
    // transcript read even if a store double were handed an unbound pointer.
    const boundToThisSession = isObjectIdBoundTo(pointer, {
      tenantId: scope.tenantId,
      userId: gate.userId,
      sessionId: id,
    });
    const blob = await resolveBlobStore();
    if (boundToThisSession && blob.ok) {
      try {
        readUrl = await blob.value.readUrl(pointer);
      } catch {
        readUrl = null;
      }
    }
  }

  return Response.json({ ...got.value, ...(readUrl ? { transcriptReadUrl: readUrl } : {}) });
}

/**
 * PUT /api/sessions/:id/envelope — upsert the small envelope (ownership/LWW/meta/
 * pointer). Body `{ id, updatedAt, meta? }`; body `id` must equal path `:id`.
 * Stale `updatedAt <` stored → 409 + server envelope.
 */
export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const badId = invalidIdResponse(id);
  if (badId) return badId;

  const raw = await req.text();
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

  if (body.id !== id) {
    return Response.json(
      { error: 'body id must match the path id.', code: 'ID_MISMATCH' },
      { status: 400 },
    );
  }

  const scope = await requireScopeFor(gate.userId);
  if (!scope.ok) return scope.response;

  const store = scope.store;
  if (!isEnvelopeStore(store)) {
    return unavailableResponse('ENVELOPE_STORE_UNAVAILABLE', 'envelope store unavailable');
  }

  // Validate as an envelope (never a transcript): reserved `meta` (incl. the Redis-safe
  // `transcriptPointer`) + LWW `updatedAt`.
  const candidate = {
    id,
    userId: gate.userId,
    tenantId: scope.tenantId,
    createdAt: 0, // create-preserve; store upsert keeps stored createdAt
    updatedAt: body.updatedAt,
    meta: body.meta,
  };
  const validated = validateSessionEnvelope(candidate);
  if (!validated.ok) {
    return Response.json(
      { error: validated.error, code: validated.code.toUpperCase() },
      { status: 400 },
    );
  }

  // Authorization binding (reader's Major L2): a `meta.transcriptPointer` may only
  // reference an object **minted for THIS session** — the server re-derives the
  // session's object-binding prefix and rejects a foreign/guessed id. This closes the
  // plant-another-user's-pointer IDOR: the attacker can only PUT a pointer bound to
  // their own {tenantId,userId,sessionId}, never a transcript minted for someone else.
  const pointer = validated.value.meta?.transcriptPointer;
  if (
    typeof pointer === 'string' &&
    pointer &&
    !isObjectIdBoundTo(pointer, {
      tenantId: scope.tenantId,
      userId: gate.userId,
      sessionId: id,
    })
  ) {
    return Response.json(
      {
        error:
          'meta.transcriptPointer must reference an object minted for this session.',
        code: 'INVALID_META',
      },
      { status: 400 },
    );
  }

  // Plan #936 / adversarial-review #937: same confused-deputy gate as
  // transcriptPointer. Seed still bind-checks, but a planted unbound id
  // must not land on the envelope.
  const mmPointer = validated.value.meta?.modelMessagesPointer;
  if (
    typeof mmPointer === 'string' &&
    mmPointer &&
    !isObjectIdBoundTo(mmPointer, {
      tenantId: scope.tenantId,
      userId: gate.userId,
      sessionId: id,
    })
  ) {
    return Response.json(
      {
        error:
          'meta.modelMessagesPointer must reference an object minted for this session.',
        code: 'INVALID_META',
      },
      { status: 400 },
    );
  }

  const input: SessionEnvelopeInput = {
    id: validated.value.id,
    userId: validated.value.userId,
    tenantId: validated.value.tenantId,
    updatedAt: validated.value.updatedAt,
    meta: validated.value.meta,
  };

  const key: SessionRecordKey = sessionKeyFor(scope.tenantId, gate.userId, id);
  const result = await guardStore(() => store.upsertEnvelope(key, input));
  if (!result.ok) return result.response;
  if (result.value.status === 'conflict') {
    return Response.json(result.value.server, { status: 409 });
  }
  return Response.json(result.value.envelope);
}
