/**
 * GET/PUT/DELETE /api/session — cloud multi-device harness session.
 * Auth required. Ownership always from session user id.
 */
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  deleteHarnessSession,
  getHarnessSession,
  putHarnessSession,
  validateSessionSnapshot,
} from '../../../lib/tenancy/harnessSessions';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';

async function requireAuthedUserId(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return { ok: false, response: sessionGate.response };
  }
  const userId = sessionGate.user?.id;
  if (!userId) {
    return {
      ok: false,
      response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
    };
  }
  return { ok: true, userId };
}

/**
 * GET /api/session — return { id, updatedAt, messages } or 404 if no row.
 */
export async function GET(): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;

  const result = await getHarnessSession(gate.userId);
  if (!result.ok) {
    if (result.code === 'not_found') {
      return Response.json({ error: result.error, code: 'NOT_FOUND' }, { status: 404 });
    }
    return Response.json({ error: result.error }, { status: 503 });
  }
  return Response.json(result.value);
}

/**
 * PUT /api/session — LWW upsert by session user id.
 * Stale updatedAt (< server) → 409 + server snapshot body.
 */
export async function PUT(req: Request): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;

  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > HARNESS_SESSION_MAX_BODY_BYTES) {
      return Response.json(
        { error: 'Request body too large.', code: 'BODY_TOO_LARGE' },
        { status: 413 },
      );
    }
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > HARNESS_SESSION_MAX_BODY_BYTES) {
    return Response.json(
      { error: 'Request body too large.', code: 'BODY_TOO_LARGE' },
      { status: 413 },
    );
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    return Response.json(
      { error: 'Invalid JSON body.', code: 'INVALID_JSON' },
      { status: 400 },
    );
  }

  const validated = validateSessionSnapshot(parsed);
  if (!validated.ok) {
    return Response.json(
      { error: validated.error, code: validated.code.toUpperCase() },
      { status: 400 },
    );
  }

  const result = await putHarnessSession(gate.userId, validated.value);
  if (!result.ok) {
    if (result.code === 'conflict' && result.value) {
      return Response.json(result.value, { status: 409 });
    }
    return Response.json({ error: result.error }, { status: 503 });
  }
  return Response.json(result.value);
}

/**
 * DELETE /api/session — idempotent; 204 whether or not a row existed.
 */
export async function DELETE(): Promise<Response> {
  const gate = await requireAuthedUserId();
  if (!gate.ok) return gate.response;

  const result = await deleteHarnessSession(gate.userId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
