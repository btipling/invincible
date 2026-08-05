import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { tenancyEnabled } from '../../lib/tenancy/enabled';
import { loadSoleMembership } from '../../lib/tenancy/soleMembership';
import type { TenantRole } from '../../lib/tenancy/roles';

export type SettingsContext = {
  userId: string;
  tenantId: string;
  role: TenantRole;
  email: string | null | undefined;
};

export type SettingsGateResult =
  | { ok: true; value: SettingsContext }
  | {
      ok: false;
      kind: 'tenancy_off' | 'forbidden' | 'error';
      message: string;
      hint: string;
    };

/**
 * Gate for /settings/* — any sole membership role (member|admin|owner).
 * Never uses canAccessAdmin.
 */
export async function gateSettingsPage(
  callbackUrl = '/settings',
): Promise<SettingsGateResult> {
  if (!tenancyEnabled()) {
    return {
      ok: false,
      kind: 'tenancy_off',
      message: 'Tenancy is not enabled.',
      hint: 'Set DATABASE_URL, AUTH_SECRET, and CREDENTIALS_ENCRYPTION_KEY to use Settings.',
    };
  }

  const session = await auth();
  if (!session?.user?.id) {
    const cb = callbackUrl.startsWith('/') ? callbackUrl : '/settings';
    redirect(`/login?callbackUrl=${encodeURIComponent(cb)}`);
  }

  const membership = await loadSoleMembership(session.user.id);
  if (!membership.ok) {
    const message =
      membership.reason === 'no_membership'
        ? 'No tenant membership found.'
        : membership.reason === 'ambiguous'
          ? 'Multiple tenant memberships — v1 Settings requires exactly one.'
          : 'Could not load membership (database unavailable).';
    const hint =
      membership.reason === 'no_membership'
        ? 'Contact a tenant owner if you need access.'
        : membership.reason === 'ambiguous'
          ? 'v1 supports a single tenant membership per user.'
          : 'Check DATABASE_URL / pooler connectivity and try again.';
    return {
      ok: false,
      kind:
        membership.reason === 'no_membership' || membership.reason === 'ambiguous'
          ? 'forbidden'
          : 'error',
      message,
      hint,
    };
  }

  return {
    ok: true,
    value: {
      userId: session.user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      email: session.user.email,
    },
  };
}
