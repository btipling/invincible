'use client';

import { useActionState } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import {
  loginAction,
  oidcSignInAction,
  type LoginState,
} from './actions';

const initial: LoginState = {};

export type OidcUi = {
  configured: boolean;
  label: string;
};

export function LoginForm({
  callbackUrl,
  oidc,
}: {
  callbackUrl: string;
  oidc: OidcUi;
}) {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: '100%',
        maxWidth: 360,
      }}
    >
      <form
        action={formAction}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          width: '100%',
        }}
      >
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: teal.text,
          }}
        >
          <span style={{ fontSize: 13, color: teal.muted }}>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${teal.border}`,
              background: teal.surface,
              color: teal.text,
              fontSize: 15,
            }}
          />
        </label>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: teal.text,
          }}
        >
          <span style={{ fontSize: 13, color: teal.muted }}>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${teal.border}`,
              background: teal.surface,
              color: teal.text,
              fontSize: 15,
            }}
          />
        </label>
        {/* Reserved height so submit does not jump when error appears */}
        <p
          role={state.error ? 'alert' : undefined}
          style={{
            margin: 0,
            minHeight: '1.35em',
            color: ember.accent,
            fontSize: 14,
            lineHeight: 1.35,
          }}
        >
          {state.error ?? '\u00a0'}
        </p>
        <button
          type="submit"
          disabled={pending}
          style={{
            marginTop: 0,
            padding: '10px 14px',
            borderRadius: 8,
            border: 'none',
            background: pending ? teal.accentDark : teal.accent,
            color: teal.bg,
            fontWeight: 600,
            fontSize: 15,
            cursor: pending ? 'wait' : 'pointer',
          }}
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/* Reserved SSO slot: fixed min height when OIDC configured (server-known; no post-paint jump) */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: oidc.configured ? 72 : 0,
        }}
      >
        {oidc.configured ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: teal.muted,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  flex: 1,
                  height: 1,
                  background: teal.border,
                }}
              />
              <span>or</span>
              <span
                style={{
                  flex: 1,
                  height: 1,
                  background: teal.border,
                }}
              />
            </div>
            <form action={oidcSignInAction}>
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <button
                type="submit"
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: `1px solid ${teal.border}`,
                  background: teal.bg,
                  color: teal.accent,
                  fontWeight: 600,
                  fontSize: 15,
                  cursor: 'pointer',
                }}
              >
                {oidc.label}
              </button>
            </form>
          </>
        ) : null}
      </div>

      <p style={{ margin: 0, fontSize: 12, color: teal.muted }}>
        Seeded operator uses{' '}
        <code style={{ color: warm.accent }}>SEED_ADMIN_*</code> credentials
        after <code style={{ color: warm.accent }}>npm run db:seed</code>.
        {oidc.configured
          ? ' SSO uses your organization IdP when configured.'
          : null}
      </p>
    </div>
  );
}
