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

type SkillVersionSummary = {
  id: string;
  label: string;
  createdAt: string; // ISO string
};

/** List version summaries for a skill (no body). */
async function listVersions(
  id: string,
): Promise<{ ok: boolean; versions?: SkillVersionSummary[]; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/skills/${encodeURIComponent(id)}/versions`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) {
      let msg = `Could not load versions (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* keep fallback */ }
      return { ok: false, error: msg };
    }
    const j = (await res.json()) as {
      ok: boolean;
      versions?: SkillVersionSummary[];
    };
    return { ok: true, versions: j.versions ?? [] };
  } catch {
    return { ok: false, error: 'Network error loading versions.' };
  }
}

/** Get a single version body as raw text. */
async function getVersionBody(
  skillId: string,
  versionId: string,
): Promise<{ ok: boolean; body?: string; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}`,
      { credentials: 'same-origin' },
    );
    if (!res.ok) {
      let msg = `Could not load version (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* keep fallback */ }
      return { ok: false, error: msg };
    }
    return { ok: true, body: await res.text() };
  } catch {
    return { ok: false, error: 'Network error loading version.' };
  }
}

/** Rollback to a version. */
async function postRollback(
  skillId: string,
  versionId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/skills/${encodeURIComponent(skillId)}/rollback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId }),
        credentials: 'same-origin',
      },
    );
    if (!res.ok) {
      let msg = `Rollback failed (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && typeof j.error === 'string') msg = j.error;
      } catch { /* keep fallback */ }
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error during rollback.' };
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

  // Version timeline state (plan #711 phase 1).
  const [versions, setVersions] = useState<SkillVersionSummary[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  // Diff view: selected version id → its raw body.
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null);
  const [diffBody, setDiffBody] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Rollback state.
  const [rollbackPending, setRollbackPending] = useState(false);
  const [rollbackFeedback, setRollbackFeedback] = useState<{
    ok?: boolean;
    message?: string;
    error?: string;
  }>({});

  async function loadVersions() {
    setVersionsLoading(true);
    setVersionsError(null);
    const r = await listVersions(row.id);
    setVersionsLoading(false);
    if (r.ok && r.versions) {
      setVersions(r.versions);
    } else {
      setVersionsError(r.error ?? 'Could not load versions.');
    }
  }

  async function showDiff(versionId: string) {
    if (diffVersionId === versionId) {
      setDiffVersionId(null);
      setDiffBody(null);
      return;
    }
    setDiffVersionId(versionId);
    setDiffBody(null);
    setDiffLoading(true);
    setDiffError(null);
    const r = await getVersionBody(row.id, versionId);
    setDiffLoading(false);
    if (r.ok && r.body !== undefined) {
      setDiffBody(r.body);
    } else {
      setDiffError(r.error ?? 'Could not load version body.');
    }
  }

  async function doRollback(versionId: string) {
    setRollbackPending(true);
    setRollbackFeedback({});
    const r = await postRollback(row.id, versionId);
    setRollbackPending(false);
    if (r.ok) {
      setRollbackFeedback({ ok: true, message: 'Rollback complete.' });
      // Invalidate loaded body + versions so the editor reflects the new state.
      setLoadedBody(null);
      setVersions(null);
    } else {
      setRollbackFeedback({ ok: false, error: r.error ?? 'Rollback failed.' });
    }
  }

  function versionDate(d: string): string {
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
  }

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
      // The timeline now has a stale **now** (the just-saved body isn't shown).
      // Invalidate it (same as rollback does) so the operator re-pulls a fresh
      // list on Show — otherwise a Restore on the stale "previous" version
      // could silently rewind the save they just made (adversarial-review L9).
      setVersions(null);
      setDiffVersionId(null);
      setDiffBody(null);
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

      {/* Version timeline (plan #711 phase 1) */}
      <div
        style={{
          marginBottom: 12,
          paddingTop: 12,
          borderTop: `1px solid ${teal.border}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: teal.muted }}>
            Version history
          </span>
          {versions === null && !versionsLoading ? (
            <button
              type="button"
              onClick={() => void loadVersions()}
              style={{ ...buttonGhostStyle(), fontSize: 12 }}
            >
              Show
            </button>
          ) : versionsLoading ? (
            <span style={{ color: teal.muted, fontSize: 12 }}>Loading…</span>
          ) : null}
        </div>
        {versionsError ? (
          <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '0 0 8px' }}>
            {versionsError}
          </p>
        ) : null}
        {versions && versions.length === 0 ? (
          <p style={{ color: teal.muted, fontSize: 13, margin: 0 }}>
            No versions yet — the first edit creates version history.
          </p>
        ) : versions ? (
          <div
            style={{
              maxHeight: 240,
              overflowY: 'auto',
              border: `1px solid ${teal.border}`,
              borderRadius: 4,
              padding: 4,
            }}
          >
            {versions.map((v, i) => {
              const isDiffing = diffVersionId === v.id;
              return (
                <div key={v.id}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 8px',
                      fontSize: 12,
                      color: teal.text,
                    }}
                  >
                    <span style={{ color: teal.muted, minWidth: 24 }}>
                      {i === 0 ? <strong>now</strong> : `v${versions.length - i}`}
                    </span>
                    <span style={{ flex: 1 }}>{versionDate(v.createdAt)}</span>
                    {v.label ? (
                      <span style={{ color: warm.accent }}>{v.label}</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void showDiff(v.id)}
                      style={{ ...buttonGhostStyle(), fontSize: 11, padding: '2px 6px' }}
                    >
                      {isDiffing ? 'Hide diff' : 'Diff'}
                    </button>
                    {i > 0 ? (
                      <button
                        type="button"
                        onClick={() => void doRollback(v.id)}
                        disabled={rollbackPending}
                        style={{
                          ...buttonGhostStyle(),
                          fontSize: 11,
                          padding: '2px 6px',
                          color: warm.accent,
                        }}
                      >
                        Restore
                      </button>
                    ) : null}
                  </div>
                  {isDiffing && diffLoading ? (
                    <div style={{ color: teal.muted, fontSize: 12, padding: '0 8px 8px' }}>
                      Loading diff…
                    </div>
                  ) : isDiffing && diffError ? (
                    <p
                      role="alert"
                      style={{ color: ember.accent, fontSize: 12, padding: '0 8px 8px', margin: 0 }}
                    >
                      {diffError}
                    </p>
                  ) : isDiffing && diffBody !== null ? (
                    <pre
                      style={{
                        margin: '0 8px 8px',
                        padding: 8,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        background: 'rgba(255,255,255,0.03)',
                        border: `1px solid ${teal.border}`,
                        borderRadius: 4,
                        color: teal.muted,
                        maxHeight: 160,
                        overflowY: 'auto',
                      }}
                    >
                      {diffBody}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <RouteFeedback
          message={rollbackFeedback.message}
          error={rollbackFeedback.error}
        />
      </div>

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
