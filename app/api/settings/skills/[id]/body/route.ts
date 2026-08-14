import { revalidatePath } from 'next/cache';
import { createProdServices } from '../../../../../../lib/di';
import {
  bodyTooLargeResponse,
  contentLengthOverLimit,
  isBodyOverLimit,
  requireUserId,
  skillErrorResponse,
} from '../../wire';

export const runtime = 'nodejs';

const services = createProdServices();

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/settings/skills/:id/body — the owner's own skill body, as **raw** plain
 * text (never JSON-wrapped, never XML/HTML-escaped). This is an un-escaped wire so a
 * 4 MiB body has genuine ~0.5 MiB headroom under the Vercel Function 4.5 MB response
 * ceiling (review #525 skill-wire plan). Ownership-tenancy is inside the store
 * (`getSkillBySlug` returns null for another-user rows — no existence leak); a body
 * is never returned to a summary/discovery surface.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const id2 = String(id ?? '').trim();
  if (!id2) {
    return Response.json({ error: 'Missing skill id.', code: 'INVALID_ID' }, { status: 400 });
  }

  const listed = await services.userSkills.listUserSkills(gate.userId);
  if (!listed.ok) {
    return skillErrorResponse(listed.code, listed.error);
  }
  const summary = listed.value.find((s) => s.id === id2);
  if (!summary) {
    return Response.json({ error: 'Skill not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  const full = await services.userSkills.getSkillBySlug(gate.userId, summary.slug);
  if (!full.ok) {
    return skillErrorResponse(full.code, full.error);
  }
  if (!full.value) {
    return Response.json({ error: 'Skill not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // Raw body — un-escaped, so the byte count we return is exactly the stored bytes.
  return new Response(full.value.body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * PUT /api/settings/skills/:id/body — replace a skill's body via a measured route.
 * The client PUTs the raw body as the request text (un-escaped); we run a
 * content-length fast-path + an authoritative byte check against
 * `SKILL_BODY_MAX_BYTES` before any store I/O. Small CRUD (details/delete) stays on
 * default-limit server actions; only the 4 MiB body travels here.
 */
export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireUserId();
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const id2 = String(id ?? '').trim();
  if (!id2) {
    return Response.json({ error: 'Missing skill id.', code: 'INVALID_ID' }, { status: 400 });
  }

  // Content-length fast-path: the PUT body IS the raw body bytes, so reject
  // over-cap declared sizes before buffering.
  if (contentLengthOverLimit(req.headers.get('content-length'))) {
    return bodyTooLargeResponse();
  }

  const raw = await req.text();
  // Authoritative byte check (raw UTF-8) — the exact bound the store persists.
  if (isBodyOverLimit(raw)) {
    return bodyTooLargeResponse();
  }

  const result = await services.userSkills.updateUserSkillBody(gate.userId, id2, raw);
  if (!result.ok) {
    return skillErrorResponse(result.code, result.error);
  }
  try {
    revalidatePath('/settings');
    revalidatePath('/settings/skills');
  } catch {
    // Best-effort; force-dynamic pages render fresh anyway.
  }
  return Response.json({ ok: true, id: result.value.id }, { status: 200 });
}
