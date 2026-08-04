import { ember, teal } from '../../lib/palette';
import {
  oidcButtonLabel,
  shouldIncludeOidcProvider,
} from '../../lib/tenancy/oidcConfig';
import { safeCallbackUrl } from '../../lib/tenancy/callbackUrl';
import { LoginForm } from './login-form';

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
          Sign in to use the harness
        </p>
        {params.error ? (
          <p
            role="alert"
            style={{
              margin: '0 0 12px',
              minHeight: '1.35em',
              color: ember.accent,
              fontSize: 14,
            }}
          >
            Sign-in was denied. Try again or use credentials.
          </p>
        ) : null}
        <LoginForm callbackUrl={callbackUrl} oidc={oidc} />
      </div>
    </main>
  );
}
