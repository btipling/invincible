import type { CSSProperties } from 'react';
import Link from 'next/link';
import { auth } from '../../auth';
import { teal } from '../../lib/palette';
import { canAccessAdmin } from '../../lib/tenancy/roles';
import { createProdServices } from '../../lib/di';
import { LogoutButton } from '../logout/LogoutButton';

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
 * Server-only auth chrome for AppNav right slot when tenancy is on.
 * Admin link only when sole membership role is owner|admin (light lookup).
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

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
      }}
    >
      {showAdmin ? (
        <Link href="/admin" style={linkStyle}>
          Admin
        </Link>
      ) : null}
      <Link href="/settings" style={linkStyle}>
        Settings
      </Link>
      <Link href="/harness" style={linkStyle}>
        Harness
      </Link>
      <LogoutButton style={linkStyle} />
    </span>
  );
}
