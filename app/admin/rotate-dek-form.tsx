'use client';

import { useActionState } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import { rotateTenantDekAction, type RotateDekState } from './actions';

const initial: RotateDekState = {};

export function RotateDekForm({ tenantId }: { tenantId: string }) {
  const [state, formAction, pending] = useActionState(
    rotateTenantDekAction,
    initial,
  );

  const showError = Boolean(state.error && state.tenantId === tenantId);
  const showOk = Boolean(state.ok && state.tenantId === tenantId);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !window.confirm(
            'Rotate the tenant encryption key? All sandbox tokens will be re-encrypted. This cannot be undone.',
          )
        ) {
          e.preventDefault();
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 8,
        maxWidth: 420,
      }}
    >
      <input type="hidden" name="tenantId" value={tenantId} />
      <p style={{ margin: 0, fontSize: 13, color: teal.muted, lineHeight: 1.4 }}>
        Generates a new per-tenant data encryption key and re-encrypts every
        sandbox token. The key is never shown.
      </p>
      <p
        role={showError ? 'alert' : undefined}
        style={{
          margin: 0,
          minHeight: '1.25em',
          fontSize: 13,
          lineHeight: 1.25,
          color: showError ? ember.accent : showOk ? warm.accent : teal.muted,
        }}
      >
        {showError
          ? state.error
          : showOk
            ? 'Encryption key rotated.'
            : '\u00a0'}
      </p>
      <button
        type="submit"
        disabled={pending}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 12px',
          borderRadius: 8,
          border: `1px solid ${ember.border}`,
          background: pending ? ember.accentDark : ember.accent,
          color: teal.bg,
          fontWeight: 600,
          fontSize: 13,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        {pending ? 'Rotating…' : 'Rotate encryption key'}
      </button>
    </form>
  );
}
