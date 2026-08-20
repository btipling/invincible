'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { createProdServices } from '../../../lib/di';
import type { UserPersonasErrorCode } from '../../../lib/tenancy/userPersonas';
import { slugFromName } from '../mcp/slugFromName';

/**
 * Phase-2 (#487) server actions for /settings/personas. Follow the sibling
 * Settings pattern (mcp/github): a `requireSettingsSession()` sole-membership
 * guard (NOT the /api/* requireSessionUser), tenancy handled inside the store.
 * Bodies never leak to the client — they stay server-side; the edit form reads
 * the owner's own body via a server-component store read.
 */
const services = createProdServices();

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/personas');
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

function mapError(code: UserPersonasErrorCode, fallback: string): string {
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
    case 'unavailable':
      return fallback || 'Personas unavailable.';
    default:
      return fallback;
  }
}

// Bound the auto-slug dedupe chain (name-derived base + `_2`, `_3`, …) so a
// display name cannot produce an unbounded collision loop. 16 KiB body cap is
// enforced in the store (PERSONA_BODY_MAX_BYTES).
const MAX_SLUG_ATTEMPTS = 50;

export type PersonaActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  id?: string;
};

/** Create a persona from a display name + body; slug derived + deduped. */
export async function createPersonaAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const name = String(formData.get('name') ?? '');
  const body = String(formData.get('body') ?? '');
  const isDefault =
    formData.get('isDefault') === 'on' || formData.get('isDefault') === 'true';

  const baseSlug = slugFromName(name || 'Persona');
  let lastCode: UserPersonasErrorCode | null = null;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i += 1) {
    const slug = i === 0 ? baseSlug : `${baseSlug}_${i + 1}`;
    const result = await services.userPersonas.createUserPersona({
      userId: session.userId,
      name,
      slug,
      body,
      isDefault,
    });
    if (result.ok) {
      revalidateSettings();
      return { ok: true, message: 'Persona created.', id: result.value.id };
    }
    if (result.code !== 'duplicate_slug') {
      return { error: mapError(result.code, result.error) };
    }
    lastCode = result.code;
  }
  void lastCode;
  return { error: 'Could not derive a unique slug for that name.' };
}

/** Rename only — keeps slug, body, and default flag. */
export async function renamePersonaAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing persona id.' };
  const name = String(formData.get('name') ?? '');

  const result = await services.userPersonas.renameUserPersona(
    session.userId,
    id,
    name,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Persona renamed.', id };
}

/** Replace the body — keeps name, slug, and default flag. */
export async function updatePersonaBodyAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing persona id.' };
  const body = String(formData.get('body') ?? '');

  const result = await services.userPersonas.updateUserPersonaBody(
    session.userId,
    id,
    body,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Persona saved.', id };
}

/** Delete a persona (clearing it as default when it was the default). */
export async function deletePersonaAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing persona id.' };

  const result = await services.userPersonas.deleteUserPersona(
    session.userId,
    id,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Persona deleted.', id };
}

/** Promote a persona to the single default. */
export async function setDefaultPersonaAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing persona id.' };

  const result = await services.userPersonas.setDefaultPersona(
    session.userId,
    id,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Default persona set.', id };
}

/** Clear the default persona (no-op when none set). */
export async function clearDefaultPersonaAction(
  _prev: PersonaActionState,
  _formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };
  // formData unused for identity — session user only (authz lock).
  void _formData;

  const result = await services.userPersonas.clearDefaultPersona(session.userId);
  if (!result.ok) {
    return { error: mapError(result.code, result.error) };
  }
  revalidateSettings();
  return { ok: true, message: 'Default persona cleared.' };
}

/** Update a persona's recommended skill slugs (plan #720 phase 3). */
export async function updatePersonaRecommendedSlugsAction(
  _prev: PersonaActionState,
  formData: FormData,
): Promise<PersonaActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const id = String(formData.get('id') ?? '').trim();
  if (!id) return { error: 'Missing persona id.' };
  const slugs = formData.getAll('slug').map((s) => String(s));

  const result = await services.userPersonas.updateRecommendedSlugs(
    session.userId,
    id,
    slugs,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error), id };
  }
  revalidateSettings();
  return { ok: true, message: 'Recommended skills saved.', id };
}
