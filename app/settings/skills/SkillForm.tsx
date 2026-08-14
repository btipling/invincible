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
  createSkillAction,
  deleteSkillAction,
  getSkillBodyAction,
  updateSkillBodyAction,
  updateSkillDetailsAction,
  type SkillActionState,
} from './actions';

export type SkillListItem = {
  id: string;
  name: string;
  slug: string;
  /** Short summary (discovery surface shows name/slug/description only). */
  description: string;
  /** Owner-own body (server-component store read via getSkillBySlug); never in discovery/picker. */
  body: string;
};

const initial: SkillActionState = {};

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

function ActionFeedback({ state }: { state: SkillActionState }) {
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
  const [state, action, pending] = useActionState(createSkillAction, initial);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  return (
    <form action={action} style={panelStyle()}>
      <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Create skill</h2>
      <Field label="Name" hint="A short label, e.g. Create pull request.">
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
      <Field
        label="Description"
        hint="One-line summary shown in discovery lookups (≤ 500 chars)."
      >
        <input
          name="description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoComplete="off"
          style={inputStyle()}
        />
      </Field>
      <Field
        label="Body"
        hint="The playbook injected when the skill is attached (≤ 4 MiB). Saved server-side."
      >
        <textarea
          name="body"
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
        />
      </Field>
      <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
        {pending ? 'Creating…' : 'Create skill'}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}

function SkillCard({ row }: { row: SkillListItem }) {
  const [detailsState, detailsAction, detailsPending] = useActionState(
    updateSkillDetailsAction,
    initial,
  );
  const [bodyState, bodyAction, bodyPending] = useActionState(
    updateSkillBodyAction,
    initial,
  );
  const [delState, delAction, delPending] = useActionState(
    deleteSkillAction,
    initial,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Skill bodies live server-side and are NOT inlined into the SSR page (review
  // #525 Major — skills wire plan). Each card loads its own body on demand via
  // `getSkillBodyAction` so one settings page never carries N large bodies in a
  // single Function response. `loadedBody` is the owner-own body once fetched;
  // `bodyError` surfaces a failed lazy load inline.
  const [loadedBody, setLoadedBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  async function loadBody() {
    setBodyLoading(true);
    setBodyError(null);
    const r = await getSkillBodyAction(row.id);
    setBodyLoading(false);
    if (r.ok) {
      setLoadedBody(r.body);
    } else {
      setBodyError(r.error || 'Could not load body.');
    }
  }

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
        <code style={{ color: warm.accent, fontSize: 12 }}>/{row.slug}</code>
      </div>
      {row.description ? (
        <p style={{ color: teal.muted, fontSize: 13, margin: '0 0 12px' }}>
          {row.description}
        </p>
      ) : null}

      <form action={detailsAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="id" value={row.id} />
        <Field label="Name" hint="Renaming never changes the /slug attach command.">
          <input
            name="name"
            type="text"
            required
            defaultValue={row.name}
            autoComplete="off"
            style={inputStyle()}
          />
        </Field>
        <Field label="Description">
          <input
            name="description"
            type="text"
            defaultValue={row.description}
            autoComplete="off"
            style={inputStyle()}
          />
        </Field>
        <button type="submit" disabled={detailsPending} style={buttonGhostStyle()}>
          {detailsPending ? 'Saving…' : 'Save name & description'}
        </button>
        <ActionFeedback state={detailsState} />
      </form>

      <form action={bodyAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="id" value={row.id} />
        <Field label="Edit body">
          {bodyLoading ? (
            <div style={{ color: teal.muted, fontSize: 13, padding: '8px 0' }}>
              Loading body…
            </div>
          ) : loadedBody === null ? (
            <div style={{ padding: '8px 0' }}>
              {bodyError ? (
                <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '0 0 8px' }}>
                  {bodyError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void loadBody()}
                style={buttonGhostStyle()}
              >
                Load body to edit
              </button>
            </div>
          ) : (
            <textarea
              name="body"
              required
              defaultValue={loadedBody}
              rows={8}
              style={{ ...inputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
            />
          )}
        </Field>
        <button
          type="submit"
          disabled={bodyPending || loadedBody === null}
          style={bodyPending ? buttonGhostStyle() : buttonGhostStyle()}
        >
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
      <ActionFeedback state={delState} />
    </div>
  );
}

export function SkillForms({ skills }: { skills: SkillListItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <CreateForm />

      {skills.length === 0 ? (
        <p role="status" style={{ color: teal.muted, fontSize: 14 }}>
          No skills yet. Create your first skill above.
        </p>
      ) : (
        skills.map((row) => <SkillCard key={row.id} row={row} />)
      )}
    </div>
  );
}
