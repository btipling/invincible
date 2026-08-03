import type { CSSProperties } from 'react';
import Link from 'next/link';
import { auth } from '../../auth';
import { teal } from '../../lib/palette';
import { tenancyEnabled } from '../../lib/tenancy/enabled';
import { logoutAction } from '../logout/actions';

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

const btnStyle: CSSProperties = {
  ...linkStyle,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/**
 * Server-only auth chrome for AppNav right slot when tenancy is on.
 * Admin link is shown to all signed-in users; page enforces owner|admin.
 */
export async function AuthNavLinks() {
  if (!tenancyEnabled()) {
    return null;
  }

  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <Link href="/login" style={linkStyle}>
        Sign in
      </Link>
    );
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
      }}
    >
      <Link href="/admin" style={linkStyle}>
        Admin
      </Link>
      <Link href="/harness" style={linkStyle}>
        Harness
      </Link>
      <form action={logoutAction} style={{ margin: 0, display: 'inline' }}>
        <button type="submit" style={btnStyle}>
          Log out
        </button>
      </form>
    </span>
  );
}
