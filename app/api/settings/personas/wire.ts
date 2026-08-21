/**
 * Shared server helpers for the /api/settings/personas version/rollback routes
 * (plan #726, source #534 — the personas version-history + rollback surface).
 *
 * Gate: mirrors the skills REST surface (`requireUserId` wrapping
 * `requireSessionUser`, review finding #3) — NOT the persona server-action
 * file-private `requireSettingsSession()`. Persona bodies are ≤ 16 KiB
 * (`PERSONA_BODY_MAX_BYTES`) and never ride a server action here; version
 * bodies are small, so a plain JSON wire is fine (unlike the 4 MiB skill
 * body's measured raw-wire path in `app/api/settings/skills/wire.ts`).
 */
import { requireSessionUser } from '../../../../lib/tenancy/session';
import { AUTH_REQUIRED_ERROR } from '../../../../lib/tenancy/errors';
import type { UserPersonasErrorCode } from '../../../../lib/tenancy/userPersonas';

/** Auth gate: a session user id, else 401 (same shape as the /api/personas surface). */
export async function requireUserId(): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: Response }
> {
  const gate = await requireSessionUser();
  if (!gate.ok) return { ok: false, response: gate.response };
  if (!gate.user?.id) {
    return {
      ok: false,
      response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
    };
  }
  return { ok: true, userId: gate.user.id };
}

/** Map the store's typed error code to an HTTP status. */
export function personaErrorStatus(code: UserPersonasErrorCode): 400 | 404 | 503 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'unavailable':
      return 503;
    default:
      return 400;
  }
}

/** Human-readable message for a store error code. */
export function personaErrorMessage(code: UserPersonasErrorCode): string {
  switch (code) {
    case 'invalid_name':
      return 'Name must be 1–80 characters.';
    case 'invalid_slug':
      return 'Slug must be a–z, digits, underscore (max 64), starting with a letter.';
    case 'invalid_body':
      return 'Body is required and must be at most 16 KiB.';
    case 'duplicate_slug':
      return 'That slug is already used.';
    case 'not_found':
      return 'Persona not found.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'limit_reached':
      return 'You have reached the maximum number of personas.';
    case 'unavailable':
      return 'Personas are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).';
    default:
      return 'Could not update persona.';
  }
}

export function personaErrorResponse(
  code: UserPersonasErrorCode,
  fallback?: string,
): Response {
  return Response.json(
    { error: fallback || personaErrorMessage(code), code: code.toUpperCase() },
    { status: personaErrorStatus(code) },
  );
}
