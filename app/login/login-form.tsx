'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';
import { ember, teal, warm } from '../../lib/palette';

const initial: LoginState = {};

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initial);

  return (
    <form
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        width: '100%',
        maxWidth: 360,
      }}
    >
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: teal.text }}>
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
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: teal.text }}>
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
      <p style={{ margin: 0, fontSize: 12, color: teal.muted }}>
        Seeded operator uses <code style={{ color: warm.accent }}>SEED_ADMIN_*</code> credentials
        after <code style={{ color: warm.accent }}>npm run db:seed</code>. SSO later.
      </p>
    </form>
  );
}
