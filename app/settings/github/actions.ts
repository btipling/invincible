'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { createProdServices } from '../../../lib/di';
import type { UserGithubTokenErrorCode } from '../../../lib/tenancy/userGithubToken';

/** Phase-1 DI: server actions wire through the composition root. */
const services = createProdServices();

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/github');
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

function mapError(code: UserGithubTokenErrorCode, fallback: string): string {
  switch (code) {
    case 'invalid_token':
      return fallback || 'Invalid token (non-empty, max 8192 characters, no control characters).';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'unavailable':
      return (
        fallback ||
        'GitHub token storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
      );
    default:
      return fallback;
  }
}

export type GithubTokenActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export async function setGithubTokenAction(
  _prev: GithubTokenActionState,
  formData: FormData,
): Promise<GithubTokenActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const token = String(formData.get('token') ?? '');
  const result = await services.userGithubToken.setUserGithubToken(
    session.userId,
    token,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'GitHub token saved.' };
}

export async function clearGithubTokenAction(
  _prev: GithubTokenActionState,
  formData: FormData,
): Promise<GithubTokenActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  // formData unused for identity — session user only (authz lock).
  void formData;

  const result = await services.userGithubToken.clearUserGithubToken(
    session.userId,
  );
  if (!result.ok) {
    return { error: mapError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'GitHub token cleared.' };
}
