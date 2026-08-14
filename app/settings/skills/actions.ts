'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { createProdServices } from '../../../lib/di';
import type { UserSkillsErrorCode } from '../../../lib/tenancy/userSkills';

/**
 * Phase-2 (#496) server actions for /settings/skills. Clone the Personas
 * Settings slice minus the default-flag concept: a sole-membership
 * requireSettingsSession() guard, tenancy handled inside the Phase 1 store
 * (lib/tenancy/userSkills.ts), and bodies never leak to the client — the edit
 * forms read the owner's own body via a measured route
 * (`GET /api/settings/skills/:id/body`), never via an action return.
 *
 * Review #525 skill-wire plan: the generous #514 skill body cap (4 MiB) is OUT of
 * scope for server actions — Next 15's 1 MB default `bodySizeLimit` would reject it,
 * and a global raise would endorse an above-ceiling Function body. Body-bearing
 * writes travel measured route handlers (`POST /api/settings/skills` create-with-body,
 * `PUT /api/settings/skills/:id/body` replace-body) with a content-length fast-path +
 * authoritative byte check against `SKILL_BODY_MAX_BYTES` and a raw wire. Only the
 * small CRUD (name/description edit + delete) stays here on the default action limit.
 *
 * Slug is auto-derived and immutable (derived in the create route from
 * slugFromName + `_N` dedupe); renaming edits name + description only
 * (updateUserSkillSummary) and never changes the slug/`/slug` attach command.
 */
const services = createProdServices();

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/skills');
}

async function requireSettingsSession(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const membership = await services.soleMembership.loadSoleMembership(userId);
  if (!membership.ok) {
    if (membership.reason === 'ambiguous') {
      return {
        ok: false,
        error: 'Multiple tenant memberships — v1 Settings requires exactly one.',
      };
    }
    if (membership.reason === 'db') {
      return {
        ok: false,
        error: 'Could not load membership (database unavailable).',
      };
    }
    return { ok: false, error: 'No tenant membership found.' };
  }
  return { ok: true, userId };
}

function mapError(code: UserSkillsErrorCode, fallback: string): string {
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
      return fallback || 'Skills are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).';
    default:
      return fallback;
  }
}

export type SkillActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  id?: string;
};

/** Edit name + description together (keeps slug + body; slug is immutable). */
export async function updateSkillDetailsAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing skill id.' };
  const name = String(formData.get('name') ?? '');
  const description = String(formData.get('description') ?? '');

  const result = await services.userSkills.updateUserSkillSummary(
    session.userId,
    id,
    { name, description },
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Skill details saved.', id };
}

/** Delete a skill. */
export async function deleteSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing skill id.' };

  const result = await services.userSkills.deleteUserSkill(session.userId, id);
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Skill deleted.', id };
}
