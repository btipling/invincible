/**
 * Phase 0 (#515) — `/api/sessions/:id/transcript` — the Blob transcript object
 * surface for the envelope carrier.
 *
 * - `POST` — mint a short-lived, scoped, credential-checked upload URL for a new
 *   append-only transcript segment. The server holds the Blob credential; the
 *   returned `uploadUrl` is a client→Blob PUT target (never a fat body through a
 *   Function). The client echoes `{ objectId }` back via the envelope upsert so the
 *   Redis envelope's `meta.transcriptPointer` advances.
 * - `GET` — server-signed read URL for a specific object page (`?objectId=`), so the
 *   host pages from Blob instead of a whole-record Function GET.
 *
 * Auth required (same session-case middleware as `/api/sessions/:id`). Ownership is
 * always the authed user within their tenant. Each minted transcript object is
 * **bound to the owning session** `{tenantId,userId,sessionId}` (its id carries a
 * binding prefix the server re-derives and verifies) so a pointer minted for one
 * session can never be planted onto another session's envelope or read/signed by a
 * foreign caller (reader's Major L2).
 */
import { requireSessionUser } from '../../../../../lib/tenancy/session';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';
import { isRedisSafeOpaqueId } from '../../../../../lib/sessionCloudCaps';
import {
  isObjectIdBoundTo,
  type ObjectScope,
} from '../../../../../lib/sessions/blobStore';
import {
  type SessionRecordKey,
  isEnvelopeStore,
} from '../../../../../lib/sessions/sessionStore';
import { createProdServices } from '../../../../../lib/di';
import { resolveBlobStore } from '../../../../../lib/tenancy/harnessSessionsRedis';
import {
  guardStore,
  resolveSessionStore,
  sessionKeyFor,
  unavailableResponse,
} from '../../../../../lib/tenancy/harnessSessionsRedis';

const { harnessSessionsRedis } = createProdServices();

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; transcript?: string }> };

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

async function resolveTenantFor(
  userId: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; response: Response }> {
  const tenant = await harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenant.ok) {
    return { ok: false, response: unavailableResponse(tenant.code, tenant.error) };
  }
  return { ok: true, tenantId: tenant.value };
}

/**
 * Load the envelope so a signed read is **authorization-bound** to this session
 * (reader's Major L2): `GET /transcript?objectId=` may only sign the object the
 * requesting session's envelope actually points to. An arbitrary (even Redis-safe)
 * `objectId` belonging to some other session/user must 404 — never a leaked/guessed
 * id signed under the caller's auth. Returns a 404 response wrapped from the store.
 */
async function resolveOwnedTranscriptPointer(
  userId: string,
  tenantId: string,
  id: string,
): Promise<{ ok: true; pointer: string } | { ok: false; response: Response }> {
  const resolved = await resolveSessionStore();
  if (!resolved.ok) {
    return { ok: false, response: unavailableResponse(resolved.code, resolved.error) };
  }
  const store = resolved.value;
  if (!isEnvelopeStore(store)) {
    // No envelope seam → no bound pointer → nothing to sign.
    return {
      ok: false,
      response: Response.json({ error: 'Transcript object not found.', code: 'NOT_FOUND' }, { status: 404 }),
    };
  }
  const key: SessionRecordKey = sessionKeyFor(tenantId, userId, id);
  const got = await guardStore(() => store.readEnvelope(key));
  if (!got.ok) return { ok: false, response: got.response };
  if (!got.value) {
    return {
      ok: false,
      response: Response.json({ error: 'Session not found.', code: 'NOT_FOUND' }, { status: 404 }),
    };
  }
  const pointer = got.value.meta.transcriptPointer;
  if (typeof pointer !== 'string' || !pointer) {
    return {
      ok: false,
      response: Response.json({ error: 'Transcript object not found.', code: 'NOT_FOUND' }, { status: 404 }),
    };
  }
  return { ok: true, pointer };
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

/**
 * POST /api/sessions/:id/transcript — mint a short-lived scoped upload URL for a new
 * transcript segment. Body optional `{ contentType?: string }`. Returns
 * `{ uploadUrl, objectId, readUrl? }`. Never returns the server's Blob credential.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const badId = invalidIdResponse(id);
  if (badId) return badId;

  const tenant = await resolveTenantFor(gate.userId);
  if (!tenant.ok) return tenant.response;

  let contentType: string | undefined;
  const raw = await req.text();
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.contentType !== undefined && parsed.contentType !== null) {
        if (typeof parsed.contentType !== 'string' || parsed.contentType.length > 120) {
          return Response.json(
            { error: 'contentType must be a non-empty string.', code: 'INVALID_CONTENT_TYPE' },
            { status: 400 },
          );
        }
        contentType = parsed.contentType;
      }
    } catch {
      return Response.json(
        { error: 'Invalid JSON body.', code: 'INVALID_JSON' },
        { status: 400 },
      );
    }
  }

  const store = await resolveBlobStore();
  if (!store.ok) return unavailableResponse(store.code, store.error);

  // Bind the minted object to THIS session's ownership scope. The object id IS the
  // Blob pathname AND the Redis envelope pointer; its binding prefix is derived from
  // `scope` so the server can re-derive and verify the pointer belongs to this exact
  // {tenantId,userId,sessionId} at envelope-write and read time. The Blob namespace is
  // intentionally flat (`t_…` pathname) — the security property is the derivable
  // binding prefix + server-side verification, NOT a hierarchical
  // `harness/{tenant}/{user}/{session}` key prefix (reader's Nit L8).
  const scope: ObjectScope = {
    tenantId: tenant.tenantId,
    userId: gate.userId,
    sessionId: id,
  };
  try {
    const minted = await store.value.mintUpload({ scope, contentType });
    return Response.json(minted, { status: 200 });
  } catch {
    return unavailableResponse('BLOB_STORE_UNAVAILABLE', 'transcript store unavailable');
  }
}

/**
 * GET /api/sessions/:id/transcript?objectId=… — a server-signed read URL for one
 * transcript object page, so the host pages from Blob (never a whole-record Function
 * GET on the hot path).
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await authedUserGate();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const badId = invalidIdResponse(id);
  if (badId) return badId;

  const tenant = await resolveTenantFor(gate.userId);
  if (!tenant.ok) return tenant.response;

  const objectId = new URL(req.url).searchParams.get('objectId');
  if (!objectId || !isRedisSafeOpaqueId(objectId)) {
    return Response.json(
      { error: 'objectId must be a Redis-safe opaque id.', code: 'INVALID_OBJECT_ID' },
      { status: 400 },
    );
  }

  // Authorization: only this session's own envelope pointer may be read. Without
  // this gate, an authed user could ask for another user's leaked/guessed objectId
  // and get a signed GET of their transcript (reader's Major L2 IDOR).
  const owned = await resolveOwnedTranscriptPointer(gate.userId, tenant.tenantId, id);
  if (!owned.ok) return owned.response;
  if (owned.pointer !== objectId) {
    return Response.json(
      { error: 'Transcript object not found.', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }
  // Defense in depth (reader's Major L2): re-derive this session's object-binding
  // prefix and require the id to match. The envelope pointer is PUT-gated to be
  // session-bound today, but this guarantees a foreign/planted id is never signed
  // even if a store double were handed an unbound pointer.
  if (
    !isObjectIdBoundTo(objectId, {
      tenantId: tenant.tenantId,
      userId: gate.userId,
      sessionId: id,
    })
  ) {
    return Response.json(
      { error: 'Transcript object not found.', code: 'NOT_FOUND' },
      { status: 404 },
    );
  }

  const store = await resolveBlobStore();
  if (!store.ok) return unavailableResponse(store.code, store.error);

  try {
    const readUrl = await store.value.readUrl(objectId);
    if (!readUrl) {
      return Response.json(
        { error: 'Transcript object not found.', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    return Response.json({ readUrl, objectId }, { status: 200 });
  } catch {
    return unavailableResponse('BLOB_STORE_UNAVAILABLE', 'transcript store unavailable');
  }
}
