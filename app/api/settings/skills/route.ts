import { revalidatePath } from 'next/cache';
import { createProdServices } from '../../../../lib/di';
import {
  SKILL_BODY_WIRE_OVERHEAD_BYTES,
  bodyTooLargeResponse,
  contentLengthOverLimit,
  isBodyOverLimit,
  requireUserId,
  skillErrorResponse,
  slugBase,
} from './wire';

export const runtime = 'nodejs';

const services = createProdServices();

// Bound the auto-slug dedupe chain (name-derived base + `_2`, `_3`, …) so a display
// name cannot produce an unbounded collision loop. Body/description caps are enforced
// in the store; this route's authoritative byte check runs first (raw, un-escaped).
const MAX_SLUG_ATTEMPTS = 50;

/**
 * POST /api/settings/skills — create a skill WITH its body, via a measured route.
 *
 * Review #525 skill-wire plan: this is the **single measured route for
 * create-with-body** (the approved recommendation) — a default-limit server action
 * cannot carry the 4 MiB body. The client posts multipart `FormData`
 * (`name`/`description`/`body`); the body field content travels **raw** (no JSON
 * string escaping), so a 4 MiB body keeps genuine headroom under the Vercel Function
 * 4.5 MB request ceiling. We run a content-length fast-path + an authoritative
 * byte check against `SKILL_BODY_MAX_BYTES` before any store I/O.
 *
 * Slug is auto-derived and immutable (slugFromName + `_N` dedupe), matching the old
 * `createSkillAction`. Auth: `requireSessionUser`; tenancy lives inside the store.
 */
export async function POST(req: Request): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;

  // Content-length fast-path for the multipart wire (over-cap declared → 413 before
  // buffering). Allowance covers the small multipart overhead beyond the raw body bytes.
  if (
    contentLengthOverLimit(
      req.headers.get('content-length'),
      SKILL_BODY_WIRE_OVERHEAD_BYTES,
    )
  ) {
    return bodyTooLargeResponse();
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { error: 'Invalid multipart body.', code: 'INVALID_BODY' },
      { status: 400 },
    );
  }
  const name = String(form.get('name') ?? '');
  const description = String(form.get('description') ?? '');
  const body = String(form.get('body') ?? '');

  // Authoritative byte check — the exact bound the store's `validateBody` persists.
  if (isBodyOverLimit(body)) {
    return bodyTooLargeResponse();
  }

  const baseSlug = slugBase(name);
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i += 1) {
    const slug = i === 0 ? baseSlug : `${baseSlug}_${i + 1}`;
    const result = await services.userSkills.createUserSkill({
      userId: gate.userId,
      name,
      slug,
      body,
      description,
    });
    if (result.ok) {
      try {
        revalidatePath('/settings');
        revalidatePath('/settings/skills');
      } catch {
        // Revalidation is best-effort; force-dynamic pages render fresh anyway.
      }
      return Response.json({ ok: true, id: result.value.id }, { status: 201 });
    }
    if (result.code !== 'duplicate_slug') {
      return skillErrorResponse(result.code, result.error);
    }
  }

  return Response.json(
    { error: 'Could not derive a unique slug for that name.', code: 'DUPLICATE_SLUG' },
    { status: 400 },
  );
}
