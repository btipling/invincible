import { ember, teal } from '../../lib/palette';
import { createProdServices } from '../../lib/di';
import {
  oidcButtonLabel,
  shouldIncludeOidcProvider,
} from '../../lib/tenancy/oidcConfig';
import { safeCallbackUrl } from '../../lib/tenancy/callbackUrl';
import { LoginForm } from './login-form';
import { SignupForm } from './signup-form';

/** Phase-1 DI: the login page wires through the composition root. */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in · Invincible',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(params.callbackUrl, '/harness');

  // First-run gate: render the sign-up form only while the DB has no tenant.
  // DB-down / connection error defaults to the existing login form (fail-open
  // to login, never a broken page). While first-run we also suppress the OIDC
  // SSO control, because SSO can only join an existing tenant and cannot
  // bootstrap a tenant-less DB.
  let firstName = false;
  try {
    firstName = !(await services.firstRun.hasAnyTenant());
  } catch {
    firstName = false;
  }

  const oidcConfigured = shouldIncludeOidcProvider();
  const oidc = {
    configured: oidcConfigured,
    label: oidcButtonLabel(),
  };

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: teal.bg,
        color: teal.text,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          padding: 28,
          borderRadius: 12,
          border: `1px solid ${teal.border}`,
          background: teal.surface,
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
      >
        <h1
          style={{
            margin: '0 0 4px',
            fontSize: 22,
            fontWeight: 650,
            color: teal.text,
          }}
        >
          Invincible
        </h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: teal.muted }}>
          {firstName
            ? 'First-run setup — create your tenant'
            : 'Sign in to use the harness'}
        </p>
        <p
          role={params.error ? 'alert' : undefined}
          style={{
            margin: '0 0 12px',
            minHeight: '1.35em',
            color: ember.accent,
            fontSize: 14,
            lineHeight: 1.35,
          }}
        >
          {params.error
            ? 'Sign-in was denied. Try again or use credentials.'
            : ' '}
        </p>
        {firstName ? (
          <SignupForm />
        ) : (
          <LoginForm callbackUrl={callbackUrl} oidc={oidc} />
        )}
      </div>
    </main>
  );
}
