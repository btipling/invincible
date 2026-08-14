'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { createProdServices } from '../../../lib/di';
import type { UserSkillsErrorCode } from '../../../lib/tenancy/userSkills';
import { slugFromName } from '../mcp/slugFromName';

/**
 * Phase-2 (#496) server actions for /settings/skills. Clone the Personas
 * Settings slice minus the default-flag concept: a sole-membership
 * requireSettingsSession() guard, tenancy handled inside the Phase 1 store
 * (lib/tenancy/userSkills.ts), and bodies never leak to the client — the edit
 * forms read the owner's own body via a server-component store read
 * (getSkillBySlug), never via the action return.
 *
 * Slug is auto-derived and immutable (slugFromName + `_N` dedupe); renaming
 * edits name + description only (updateUserSkillSummary) and never changes the
 * slug/`/slug` attach command. Body is edited separately (updateUserSkillBody).
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
      return 'Name must be 1–256 characters.';
    case 'invalid_slug':
      return 'Slug must be a–z, digits, underscore or hyphen (max 128), starting with a letter.';
    case 'invalid_body':
      return 'Body is required and must be at most 4 MiB.';
    case 'invalid_description':
      return 'Description must be at most 20,000 characters.';
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

// Bound the auto-slug dedupe chain (name-derived base + `_2`, `_3`, …) so a
// display name cannot produce an unbounded collision loop. Body/description
// caps are enforced in the store.
const MAX_SLUG_ATTEMPTS = 50;

export type SkillActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  id?: string;
};

/** Create a skill from a display name + body (+ optional description); slug derived + deduped. */
export async function createSkillAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const name = String(formData.get('name') ?? '');
  const description = String(formData.get('description') ?? '');
  const body = String(formData.get('body') ?? '');

  const baseSlug = slugFromName(name || 'Skill');
  let lastCode: UserSkillsErrorCode | null = null;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i += 1) {
    const slug = i === 0 ? baseSlug : `${baseSlug}_${i + 1}`;
    const result = await services.userSkills.createUserSkill({
      userId: session.userId,
      name,
      slug,
      body,
      description,
    });
    if (result.ok) {
      revalidateSettings();
      return { ok: true, message: 'Skill created.', id: result.value.id };
    }
    if (result.code !== 'duplicate_slug') {
      return { error: mapError(result.code, result.error) };
    }
    lastCode = result.code;
  }
  void lastCode;
  return { error: 'Could not derive a unique slug for that name.' };
}

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

/** Replace the body — keeps name, slug, description. */
export async function updateSkillBodyAction(
  _prev: SkillActionState,
  formData: FormData,
): Promise<SkillActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing skill id.' };
  const body = String(formData.get('body') ?? '');

  const result = await services.userSkills.updateUserSkillBody(
    session.userId,
    id,
    body,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Skill body saved.', id };
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
