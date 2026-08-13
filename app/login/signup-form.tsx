'use client';

import { useActionState } from 'react';
import { ember, teal } from '../../lib/palette';
import { signupAction, type SignupState } from './signup-actions';

const initial: SignupState = {};

/**
 * First-run tenant sign-up (plane #459 / parent #473 phase 1).
 * Rendered on `/login` only while the DB has no tenant; creates the first
 * tenant + owner and signs them in. TEAL/WARM/EMBER per `lib/palette.ts`.
 */
export function SignupForm() {
  const [state, formAction, pending] = useActionState(signupAction, initial);

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
      <p style={{ margin: 0, fontSize: 14, color: teal.muted }}>
        No tenant yet — create the first one to bootstrap this deployment.
      </p>
      <form
        action={formAction}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          width: '100%',
        }}
      >
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            color: teal.text,
          }}
        >
          <span style={{ fontSize: 13, color: teal.muted }}>Tenant name</span>
          <input
            name="tenantName"
            type="text"
            autoComplete="organization"
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
          <span style={{ fontSize: 13, color: teal.muted }}>Admin email</span>
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
            autoComplete="new-password"
            required
            minLength={8}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${teal.border}`,
              background: teal.surface,
              color: teal.text,
              fontSize: 15,
            }}
          />
          <span style={{ fontSize: 12, color: teal.muted }}>
            At least 8 characters, no spaces.
          </span>
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
          {pending ? 'Creating…' : 'Create tenant & sign in'}
        </button>
      </form>
    </div>
  );
}
