import type { CSSProperties } from 'react';
import Link from 'next/link';
import { auth } from '../../auth';
import { teal } from '../../lib/palette';
import { canAccessAdmin } from '../../lib/tenancy/roles';
import { createProdServices } from '../../lib/di';
import { buildSignedInNavItems } from '../../lib/navMenu';
import { LogoutButton } from '../logout/LogoutButton';
import NavMenu from './NavMenu';

/** Phase-1 DI: server component wires through the composition root. */
const services = createProdServices();

const linkStyle: CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: teal.accent,
  textDecoration: 'none',
  padding: '0.25rem 0.5rem',
  borderRadius: 6,
  border: `1px solid ${teal.border}`,
  background: teal.surface,
};

/**
 * Server-only auth chrome for the AppNav right slot when tenancy is on.
 *
 * Signed-in: renders the shared client `NavMenu` fed pre-gated inert `items`
 * (role resolved server-side — Admin only when sole membership is owner|admin;
 * the client never decides who sees Admin) plus the existing `LogoutButton` as
 * its footer slot. Unauth: inline `Sign in` header control (unchanged).
 */
export async function AuthNavLinks() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <Link href="/login" style={linkStyle}>
        Sign in
      </Link>
    );
  }

  const membership = await services.soleMembership.loadSoleMembership(userId);
  const showAdmin = membership.ok && canAccessAdmin(membership.role);
  const items = buildSignedInNavItems({ showAdmin });

  return (
    <NavMenu
      items={items}
      ariaLabel="Account menu"
      footer={<LogoutButton style={linkStyle} />}
    />
  );
}
