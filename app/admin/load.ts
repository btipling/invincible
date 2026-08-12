import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { createProdServices } from '../../lib/di';
import type { AdminContext } from '../../lib/tenancy/adminContext';

const { adminContext } = createProdServices();

export type AdminGateResult =
  | { ok: true; value: AdminContext }
  | { ok: false; kind: 'forbidden' | 'error'; message: string; hint: string };

/**
 * Shared gate for all /admin/* pages (except layout chrome).
 */
export async function gateAdminPage(
  callbackUrl = '/admin',
): Promise<AdminGateResult> {
  const session = await auth();
  if (!session?.user?.id) {
    const cb = callbackUrl.startsWith('/') ? callbackUrl : '/admin';
    redirect(`/login?callbackUrl=${encodeURIComponent(cb)}`);
  }

  const result = await adminContext.loadAdminContext(session.user.id);
  if (!result.ok) {
    const message =
      result.reason === 'forbidden'
        ? 'You do not have admin access for this tenant.'
        : result.reason === 'no_membership'
          ? 'No tenant membership found.'
          : result.reason === 'ambiguous'
            ? 'Multiple tenant memberships — v1 admin requires exactly one.'
            : 'Could not load admin data (database unavailable).';

    const hint =
      result.reason === 'forbidden' || result.reason === 'no_membership'
        ? 'Access denied — contact a tenant owner if you need admin.'
        : result.reason === 'ambiguous'
          ? 'v1 supports a single tenant membership per user.'
          : 'Check DATABASE_URL / pooler connectivity and try again.';

    return {
      ok: false,
      kind: result.reason === 'forbidden' || result.reason === 'no_membership' ? 'forbidden' : 'error',
      message,
      hint,
    };
  }

  return { ok: true, value: result.value };
}
