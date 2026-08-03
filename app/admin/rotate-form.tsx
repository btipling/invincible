'use client';

import { useActionState, useEffect, useRef } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import { rotateTokenAction, type RotateState } from './actions';

const initial: RotateState = {};

export function RotateTokenForm({ sandboxId }: { sandboxId: string }) {
  const [state, formAction, pending] = useActionState(rotateTokenAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok && state.sandboxId === sandboxId) {
      formRef.current?.reset();
    }
  }, [state.ok, state.sandboxId, sandboxId]);

  const showError = state.error && state.sandboxId === sandboxId;
  const showOk = state.ok && state.sandboxId === sandboxId;

  return (
    <form
      ref={formRef}
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 8,
        maxWidth: 420,
      }}
    >
      <input type="hidden" name="sandboxId" value={sandboxId} />
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span style={{ color: teal.muted }}>New sandbox token (owner only)</span>
        <input
          name="newToken"
          type="password"
          autoComplete="new-password"
          required
          placeholder="Paste new bearer token"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: `1px solid ${teal.border}`,
            background: teal.bg,
            color: teal.text,
            fontSize: 14,
          }}
        />
      </label>
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
        {showError ? state.error : showOk ? 'Token updated (not shown again).' : '\u00a0'}
      </p>
      <button
        type="submit"
        disabled={pending}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 12px',
          borderRadius: 8,
          border: 'none',
          background: pending ? teal.accentDark : teal.accent,
          color: teal.bg,
          fontWeight: 600,
          fontSize: 13,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        {pending ? 'Saving…' : 'Rotate token'}
      </button>
    </form>
  );
}
