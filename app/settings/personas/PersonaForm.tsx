'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';
import {
  clearDefaultPersonaAction,
  createPersonaAction,
  deletePersonaAction,
  renamePersonaAction,
  setDefaultPersonaAction,
  updatePersonaBodyAction,
  type PersonaActionState,
} from './actions';

export type PersonaListItem = {
  id: string;
  name: string;
  slug: string;
  /** Owner-visible body (server-component store read); never a client summary. */
  body: string;
  isDefault: boolean;
};

const initial: PersonaActionState = {};

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

function ActionFeedback({ state }: { state: PersonaActionState }) {
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

function CreateForm() {
  const [state, action, pending] = useActionState(createPersonaAction, initial);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  return (
    <form action={action} style={panelStyle()}>
      <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Create persona</h2>
      <Field label="Name" hint="A short label, e.g. Frontend engineer.">
        <input
          name="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          style={inputStyle()}
        />
      </Field>
      <Field label="Body" hint="AGENTS.md-style instructions (≤ 16 KiB). Saved server-side.">
        <textarea
          name="body"
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
        />
      </Field>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          marginBottom: 12,
        }}
      >
        <input name="isDefault" type="checkbox" value="on" />
        <span>Set as the default persona</span>
      </label>
      <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
        {pending ? 'Creating…' : 'Create persona'}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}

function PersonaCard({ row, hasDefault }: { row: PersonaListItem; hasDefault: boolean }) {
  const [renameState, renameAction, renamePending] = useActionState(
    renamePersonaAction,
    initial,
  );
  const [bodyState, bodyAction, bodyPending] = useActionState(
    updatePersonaBodyAction,
    initial,
  );
  const [defState, defAction, defPending] = useActionState(
    setDefaultPersonaAction,
    initial,
  );
  const [delState, delAction, delPending] = useActionState(
    deletePersonaAction,
    initial,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={panelStyle()}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'baseline',
          marginBottom: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>{row.name}</h2>
        <code style={{ color: warm.accent, fontSize: 12 }}>{row.slug}</code>
        {row.isDefault ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: warm.accent,
              border: `1px solid ${warm.border}`,
              borderRadius: 999,
              padding: '1px 8px',
            }}
          >
            default
          </span>
        ) : null}
      </div>

      <form action={renameAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="id" value={row.id} />
        <Field label="Name">
          <input
            name="name"
            type="text"
            required
            defaultValue={row.name}
            autoComplete="off"
            style={inputStyle()}
          />
        </Field>
        <button type="submit" disabled={renamePending} style={buttonGhostStyle()}>
          {renamePending ? 'Renaming…' : 'Rename'}
        </button>
        <ActionFeedback state={renameState} />
      </form>

      <form action={bodyAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="id" value={row.id} />
        <Field label="Edit body">
          <textarea
            name="body"
            required
            defaultValue={row.body}
            rows={8}
            style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>
        <button type="submit" disabled={bodyPending} style={buttonGhostStyle()}>
          {bodyPending ? 'Saving…' : 'Save body'}
        </button>
        <ActionFeedback state={bodyState} />
      </form>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 4,
          paddingTop: 12,
          borderTop: `1px solid ${teal.border}`,
        }}
      >
        {row.isDefault ? null : (
          <form action={defAction}>
            <input type="hidden" name="id" value={row.id} />
            <button type="submit" disabled={defPending} style={buttonGhostStyle()}>
              {defPending ? '…' : hasDefault ? 'Set as default' : 'Make default'}
            </button>
          </form>
        )}
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            style={{ ...buttonGhostStyle(), color: ember.accent }}
          >
            Delete
          </button>
        ) : (
          <form action={delAction} style={{ display: 'flex', gap: 8 }}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              disabled={delPending}
              style={{
                ...buttonPrimaryStyle(),
                background: ember.accentDark,
                borderColor: ember.accentDark,
              }}
            >
              {delPending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              style={buttonGhostStyle()}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
      <ActionFeedback state={defState} />
      <ActionFeedback state={delState} />
    </div>
  );
}

export function PersonaForms({ personas }: { personas: PersonaListItem[] }) {
  const [clearState, clearAction, clearPending] = useActionState(
    clearDefaultPersonaAction,
    initial,
  );
  const hasDefault = personas.some((p) => p.isDefault);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {hasDefault ? (
        <form action={clearAction} style={{ marginBottom: 16 }}>
          <button type="submit" disabled={clearPending} style={buttonGhostStyle()}>
            {clearPending ? 'Clearing…' : 'Clear default persona'}
          </button>
          <ActionFeedback state={clearState} />
        </form>
      ) : null}

      <CreateForm />

      {personas.length === 0 ? (
        <p role="status" style={{ color: teal.muted, fontSize: 14 }}>
          No personas yet. Create your first persona above.
        </p>
      ) : (
        personas.map((row) => (
          <PersonaCard key={row.id} row={row} hasDefault={hasDefault} />
        ))
      )}
    </div>
  );
}
