'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { ember, teal } from '../../../lib/palette';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';
import {
  clearGithubTokenAction,
  setGithubTokenAction,
  type GithubTokenActionState,
} from './actions';

const initial: GithubTokenActionState = {};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
      <span
        style={{
          display: 'block',
          marginBottom: 4,
          color: teal.muted,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {children}
      {hint ? (
        <span
          style={{
            display: 'block',
            marginTop: 4,
            color: teal.muted,
            fontSize: 12,
          }}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function ActionFeedback({ state }: { state: GithubTokenActionState }) {
  if (state.error) {
    return (
      <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '8px 0 0' }}>
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p style={{ color: teal.accent, fontSize: 13, margin: '8px 0 0' }}>
        {state.message}
      </p>
    );
  }
  return null;
}

export type GithubTokenFormProps = {
  configured: boolean;
  updatedAt: string | null;
};

export function GithubTokenForm({ configured, updatedAt }: GithubTokenFormProps) {
  const [setState, setAction, setPending] = useActionState(
    setGithubTokenAction,
    initial,
  );
  const [clearState, clearAction, clearPending] = useActionState(
    clearGithubTokenAction,
    initial,
  );
  const tokenInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (setState.ok) {
      if (tokenInputRef.current) {
        tokenInputRef.current.value = '';
      }
    }
  }, [setState]);

  const busy = setPending || clearPending;
  const statusLabel = configured ? 'Configured' : 'Not configured';
  const statusColor = configured ? teal.accent : teal.muted;

  return (
    <div style={panelStyle()}>
      <p style={{ margin: '0 0 12px', color: teal.muted, fontSize: 14, lineHeight: 1.5 }}>
        Store a GitHub personal access token (fine-grained or classic) encrypted under
        your tenant key. Least privilege scopes recommended. The token is never shown
        again after save.
      </p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: 999,
            border: `1px solid ${configured ? teal.accent : teal.border}`,
            color: statusColor,
            fontWeight: 650,
          }}
        >
          {statusLabel}
        </span>
        {configured && updatedAt ? (
          <span style={{ color: teal.muted }}>
            Updated {new Date(updatedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      <form action={setAction}>
        <Field
          label={configured ? 'Replace token' : 'GitHub personal access token'}
          hint="Write-only. Paste a new token to set or replace."
        >
          <input
            ref={tokenInputRef}
            type="password"
            name="token"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            style={inputStyle()}
            placeholder="ghp_… or github_pat_…"
          />
        </Field>
        <button type="submit" disabled={busy} style={buttonPrimaryStyle()}>
          {setPending ? 'Saving…' : configured ? 'Replace token' : 'Save token'}
        </button>
        <ActionFeedback state={setState} />
      </form>

      {configured ? (
        <form
          action={clearAction}
          style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${teal.border}` }}
          onSubmit={(e) => {
            if (
              !window.confirm(
                'Clear your stored GitHub personal access token? This cannot be undone (you can paste a new token later).',
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <button type="submit" disabled={busy} style={buttonGhostStyle()}>
            {clearPending ? 'Clearing…' : 'Clear token'}
          </button>
          <ActionFeedback state={clearState} />
        </form>
      ) : null}
    </div>
  );
}
