'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '../../../auth';
import { tenancyEnabled } from '../../../lib/tenancy/enabled';
import { loadSoleMembership } from '../../../lib/tenancy/soleMembership';
import {
  setUserPreferredSandbox,
  type UserPreferredSandboxErrorCode,
} from '../../../lib/tenancy/userPreferredSandbox';

function revalidateSettings() {
  revalidatePath('/settings');
  revalidatePath('/settings/sandbox');
}

async function requireSettingsSession(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  if (!tenancyEnabled()) {
    return { ok: false, error: 'Tenancy is not enabled.' };
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: 'Authentication required.' };
  }
  const membership = await loadSoleMembership(userId);
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

function mapError(code: UserPreferredSandboxErrorCode, fallback: string): string {
  switch (code) {
    case 'not_found':
      return 'Sandbox not found in your tenant.';
    case 'forbidden':
      return 'You do not have access to that sandbox.';
    case 'invalid':
      return fallback || 'That sandbox is not usable right now.';
    case 'no_membership':
      return 'No tenant membership found.';
    case 'unavailable':
      return (
        fallback ||
        'Sandbox preference storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
      );
    default:
      return fallback;
  }
}

export type SandboxSelectActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
};

export async function selectSandboxAction(
  _prev: SandboxSelectActionState,
  formData: FormData,
): Promise<SandboxSelectActionState> {
  const session = await requireSettingsSession();
  if (!session.ok) return { error: session.error };

  const sandboxId = String(formData.get('sandboxId') ?? '');
  const result = await setUserPreferredSandbox(session.userId, sandboxId);
  if (!result.ok) {
    return { error: mapError(result.code, result.error) };
  }

  revalidateSettings();
  return { ok: true, message: 'Preferred sandbox saved. Agent turns will use this workspace.' };
}
