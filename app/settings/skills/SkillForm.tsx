'use client';

import {
  useActionState,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';
import {
  deleteSkillAction,
  updateSkillDetailsAction,
  type SkillActionState,
} from './actions';

export type SkillListItem = {
  id: string;
  name: string;
  slug: string;
  /** Short summary (discovery surface shows name/slug/description only). */
  description: string;
  /** Owner-own body; the edit form loads it on demand via a measured GET route. */
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

function RouteFeedback({ message, error }: { message?: string; error?: string }) {
  if (error) {
    return (
      <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '8px 0 0' }}>
        {error}
      </p>
    );
  }
  if (message) {
    return (
      <p style={{ color: teal.accent, fontSize: 13, margin: '8px 0 0' }}>{message}</p>
    );
  }
  return null;
}

/**
 * Create-with-body travels the measured route `POST /api/settings/skills` (review
 * #525 skill-wire plan) — NOT a server action, whose 1 MB default `bodySizeLimit`
 * would reject a 4 MiB body. Multipart carries the body bytes raw (un-escaped).
 */
async function postSkillsForm(
  form: FormData,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch('/api/settings/skills', { method: 'POST', body: form });
    if (!res.ok) {
      let msg = `Could not create skill (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch {
        /* keep fallback */
      }
      return { ok: false, error: msg };
    }
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: j.id };
  } catch {
    return { ok: false, error: 'Network error creating skill.' };
  }
}

/** Body replace travels the measured route `PUT /api/settings/skills/:id/body` (raw body). */
async function putSkillBody(
  id: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/settings/skills/${encodeURIComponent(id)}/body`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
    });
    if (!res.ok) {
      let msg = `Could not save body (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch {
        /* keep fallback */
      }
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error saving body.' };
  }
}

/** Load the owner's own body via the measured GET route (raw text, no JSON escaping). */
async function getSkillBody(id: string): Promise<
  | { ok: true; body: string }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(`/api/settings/skills/${encodeURIComponent(id)}/body`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      let msg = `Could not load body (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch {
        /* keep fallback */
      }
      return { ok: false, error: msg };
    }
    return { ok: true, body: await res.text() };
  } catch {
    return { ok: false, error: 'Network error loading body.' };
  }
}

function CreateForm() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setMessage('');
    setError('');
    const r = await postSkillsForm(form);
    setPending(false);
    if (r.ok) {
      setMessage('Skill created.');
      setName('');
      setDescription('');
      setBody('');
    } else {
      setError(r.error ?? 'Could not create skill.');
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} style={panelStyle()}>
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
        hint="One-line summary shown in discovery lookups (≤ 2000 chars)."
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
        hint="The playbook injected when the skill is attached (≤ 4 MiB). Saved server-side through the measured create route."
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
      <RouteFeedback message={message} error={error} />
    </form>
  );
}

function SkillCard({ row }: { row: SkillListItem }) {
  const [detailsState, detailsAction, detailsPending] = useActionState(
    updateSkillDetailsAction,
    initial,
  );
  const [delState, delAction, delPending] = useActionState(
    deleteSkillAction,
    initial,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Skill bodies live server-side and are NOT inlined into the SSR page. Each card
  // loads its own body on demand via the measured `GET /api/settings/skills/:id/body`
  // route (review #525 skill-wire plan), so one settings page never carries N large
  // bodies in a single Function response.
  const [loadedBody, setLoadedBody] = useState<string | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodySaving, setBodySaving] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [bodyMessage, setBodyMessage] = useState('');

  async function loadBody() {
    setBodyLoading(true);
    setBodyError(null);
    const r = await getSkillBody(row.id);
    setBodyLoading(false);
    if (r.ok) {
      setLoadedBody(r.body);
    } else {
      setBodyError(r.error || 'Could not load body.');
    }
  }

  async function onSaveBody(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = new FormData(e.currentTarget).get('body');
    if (typeof body !== 'string') return;
    setBodySaving(true);
    setBodyError(null);
    setBodyMessage('');
    const r = await putSkillBody(row.id, body);
    setBodySaving(false);
    if (r.ok) {
      setBodyMessage('Body saved.');
    } else {
      setBodyError(r.error ?? 'Could not save body.');
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

      <form onSubmit={(e) => void onSaveBody(e)} style={{ marginBottom: 12 }}>
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
          disabled={bodySaving || loadedBody === null}
          style={buttonGhostStyle()}
        >
          {bodySaving ? 'Saving…' : 'Save body'}
        </button>
        <RouteFeedback message={bodyMessage} error={bodyError ?? undefined} />
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
