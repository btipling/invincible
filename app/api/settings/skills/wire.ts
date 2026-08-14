/**
 * Shared server helpers for the /api/settings/skills measured body routes.
 *
 * Review #525 skill-wire plan: the generous #514 skill body cap
 * (`SKILL_BODY_MAX_BYTES` = 4 MiB) must NOT ride a server action — Next 15's 1 MB
 * default `bodySizeLimit` would reject it, and raising that limit globally would
 * endorse a ~5,242,880 B body *above* the inviolable 4.5 MB Vercel Function request
 * ceiling while loosening every other action. So the body travels its own measured
 * route handlers with:
 *   - a content-length fast-path (reject over-cap before buffering),
 *   - an authoritative byte check against `SKILL_BODY_MAX_BYTES` on the decoded
 *     body (the exact value the store's `validateBody` persists),
 *   - a **raw (un-escaped) wire** (multipart/plain-text, no JSON string wrapping), so
 *     a 4 MiB body keeps genuine ~0.5 MiB headroom under the 4.5 MB Function bound.
 * Small CRUD stays on default-limit server actions (updateSkillDetailsAction /
 * deleteSkillAction).
 */
import { requireSessionUser } from '../../../../lib/tenancy/session';
import { AUTH_REQUIRED_ERROR } from '../../../../lib/tenancy/errors';
import { slugFromName } from '../../../../app/settings/mcp/slugFromName';
import {
  SKILL_BODY_MAX_BYTES,
  type UserSkillsErrorCode,
} from '../../../../lib/tenancy/userSkills';

/**
 * Wire-overhead allowance for the multipart create-with-body request beyond the raw
 * body bytes (boundary lines, part headers, `name`/`description` fields). Bounded by
 * the tiny name/description caps; 64 KiB is generous headroom. A valid request is
 * always well under the Vercel Function 4.5 MB request ceiling when the body is
 * ≤ `SKILL_BODY_MAX_BYTES`.
 */
export const SKILL_BODY_WIRE_OVERHEAD_BYTES = 64 * 1024;

/** Auth gate: a session user id, else 401 (same shape as the /api/skills surface). */
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

/** The authoritative byte check — the exact bound `validBody` persists. */
export function isBodyOverLimit(body: string): boolean {
  return Buffer.byteLength(body, 'utf8') > SKILL_BODY_MAX_BYTES;
}

/** Map one machine `@vercel/blob`-style wire `content-length` fast-path reject. */
export function contentLengthOverLimit(raw: string | null, allowance = 0): boolean {
  if (raw === null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > SKILL_BODY_MAX_BYTES + allowance;
}

/** Map the store's typed error code to an HTTP status. */
export function skillErrorStatus(code: UserSkillsErrorCode): 400 | 404 | 503 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'unavailable':
      return 503;
    default:
      return 400;
  }
}

/** Human-readable message for a store error code (mirrors the settings `mapError`). */
export function skillErrorMessage(code: UserSkillsErrorCode): string {
  switch (code) {
    case 'invalid_name':
      return 'Name must be 1–200 characters.';
    case 'invalid_slug':
      return 'Slug must be a–z, digits, underscore or hyphen (max 128), starting with a letter.';
    case 'invalid_body':
      return 'Body is required and must be at most 4 MiB.';
    case 'invalid_description':
      return 'Description must be at most 2000 characters.';
    case 'duplicate_slug':
      return 'A skill with that name already exists.';
    case 'not_found':
      return 'Skill not found.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'unavailable':
      return 'Skills are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).';
    default:
      return 'Could not update skill.';
  }
}

export function bodyTooLargeResponse(): Response {
  return Response.json(
    { error: 'Request body too large.', code: 'BODY_TOO_LARGE' },
    { status: 413 },
  );
}

export function skillErrorResponse(
  code: UserSkillsErrorCode,
  fallback?: string,
): Response {
  return Response.json(
    { error: fallback || skillErrorMessage(code), code: code.toUpperCase() },
    { status: skillErrorStatus(code) },
  );
}

/** Derive the immutable auto-slug base from a display name (slugFromName + `_N` dedupe). */
export function slugBase(name: string): string {
  return slugFromName(name || 'Skill');
}
