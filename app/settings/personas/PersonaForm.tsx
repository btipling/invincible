'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import { PERSONA_VERSION_MAX } from '../../../lib/sessionCloudCaps';
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
  updatePersonaRecommendedSlugsAction,
  type PersonaActionState,
} from './actions';

export type PersonaListItem = {
  id: string;
  name: string;
  slug: string;
  /** Owner-visible body (server-component store read); never a client summary. */
  body: string;
  isDefault: boolean;
  /** Recommended skill slugs (plan #720 phase 3). */
  recommendedSkillSlugs: string[];
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

// Version history + rollback (plan #726, source #534 — persona parity with the
// shipped skill versioning). Persona bodies live server-side; the version list /
// single version body / rollback travel the /api/settings/personas REST routes.

type PersonaVersionSummary = {
  id: string;
  label: string;
  createdAt: string; // ISO string
};

/** List version summaries for a persona (no body). */
async function listVersions(
  id: string,
): Promise<{ ok: boolean; versions?: PersonaVersionSummary[]; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/personas/${encodeURIComponent(id)}/versions`,
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
      versions?: PersonaVersionSummary[];
    };
    return { ok: true, versions: j.versions ?? [] };
  } catch {
    return { ok: false, error: 'Network error loading versions.' };
  }
}

/** Get a single version body as raw text. */
async function getVersionBody(
  personaId: string,
  versionId: string,
): Promise<{ ok: boolean; body?: string; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/personas/${encodeURIComponent(personaId)}/versions/${encodeURIComponent(versionId)}`,
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
  personaId: string,
  versionId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `/api/settings/personas/${encodeURIComponent(personaId)}/rollback`,
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

function PersonaCard({ row, hasDefault, skillSlugs }: { row: PersonaListItem; hasDefault: boolean; skillSlugs: string[] }) {
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
  const [recState, recAction, recPending] = useActionState(
    updatePersonaRecommendedSlugsAction,
    initial,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Version history + rollback state (plan #726, source #534).
  const [versions, setVersions] = useState<PersonaVersionSummary[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  // Body view: selected version id → its raw body text.
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  const [viewBody, setViewBody] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  // Rollback state.
  const [rollbackPending, setRollbackPending] = useState(false);
  const [rollbackFeedback, setRollbackFeedback] = useState<{
    ok?: boolean;
    message?: string;
    error?: string;
  }>({});
  // Copy-state for the per-version "Copy body" affordance (product stance: no
  // user-confirmation gates, so a non-blocking copy lets the operator keep the
  // exact body before a one-way Restore at the cap).
  const [copiedVersionId, setCopiedVersionId] = useState<string | null>(null);

  async function copyVersionBody(versionId: string) {
    const r = await getVersionBody(row.id, versionId);
    if (!r.ok || r.body === undefined) {
      setRollbackFeedback({ ok: false, error: r.error ?? 'Could not load version body.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(r.body);
      setCopiedVersionId(versionId);
      setRollbackFeedback({});
    } catch {
      setRollbackFeedback({
        ok: false,
        error: 'Could not copy — select the inline body text manually.',
      });
    }
  }

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

  async function showView(versionId: string) {
    if (viewVersionId === versionId) {
      setViewVersionId(null);
      setViewBody(null);
      return;
    }
    setViewVersionId(versionId);
    setViewBody(null);
    setViewLoading(true);
    setViewError(null);
    const r = await getVersionBody(row.id, versionId);
    setViewLoading(false);
    if (r.ok && r.body !== undefined) {
      setViewBody(r.body);
    } else {
      setViewError(r.error ?? 'Could not load version body.');
    }
  }

  async function doRollback(versionId: string) {
    setRollbackPending(true);
    setRollbackFeedback({});
    const r = await postRollback(row.id, versionId);
    setRollbackPending(false);
    if (r.ok) {
      setRollbackFeedback({ ok: true, message: 'Rollback complete.' });
      // Invalidates loaded versions so the operator re-pulls a fresh list on
      // Show (the live body changed; mirrors the skill panel behaviour).
      setVersions(null);
      setViewVersionId(null);
      setViewBody(null);
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

      {/* Recommended skills (plan #720 phase 3) */}
      {skillSlugs.length > 0 ? (
        <form action={recAction} style={{ marginBottom: 12 }}>
          <input type="hidden" name="id" value={row.id} />
          <Field label="Recommended skills" hint="Select skills to boost when this persona is used with find_skill. These are discovery hints only — they never auto-attach.">
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                marginTop: 4,
              }}
            >
              {skillSlugs.map((slug) => {
                const checked = row.recommendedSkillSlugs.includes(slug);
                return (
                  <label
                    key={slug}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '3px 8px',
                      fontSize: 12,
                      color: checked ? warm.accent : teal.muted,
                      border: `1px solid ${checked ? warm.border : teal.border}`,
                      borderRadius: 999,
                      background: checked ? 'rgba(199,119,62,0.08)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      name="slug"
                      value={slug}
                      defaultChecked={checked}
                      style={{ margin: 0, accentColor: warm.accent }}
                    />
                    {slug}
                  </label>
                );
              })}
            </div>
          </Field>
          <button type="submit" disabled={recPending} style={buttonGhostStyle()}>
            {recPending ? 'Saving…' : 'Save recommended skills'}
          </button>
          <ActionFeedback state={recState} />
        </form>
      ) : null}

      {/* Version history + rollback (plan #726, source #534) */}
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
        {versions && versions.length >= PERSONA_VERSION_MAX ? (
          <p
            role="alert"
            style={{ color: ember.accent, fontSize: 12, margin: '0 0 8px' }}
          >
            At the {PERSONA_VERSION_MAX}-version cap — further body edits and
            Restores are rejected (Restore is disabled). Roll back only
            downgrades if you raise `PERSONA_VERSION_MAX` or delete the persona.
          </p>
        ) : versions && versions.length >= PERSONA_VERSION_MAX - 1 ? (
          <p style={{ color: warm.accent, fontSize: 12, margin: '0 0 8px' }}>
            {versions.length} of {PERSONA_VERSION_MAX} versions — the next
            Restore is the last one-way slot (edits and Restores then lock), so
            copy the body you may need first.
          </p>
        ) : null}
        {versions && versions.length === 0 ? (
          <p style={{ color: teal.muted, fontSize: 13, margin: 0 }}>
            No versions yet — this persona predates version history; the next body
            edit creates one. A newly-created persona already records its initial
            body as the first version.
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
              const isViewing = viewVersionId === v.id;
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
                      onClick={() => void copyVersionBody(v.id)}
                      style={{ ...buttonGhostStyle(), fontSize: 11, padding: '2px 6px' }}
                    >
                      {copiedVersionId === v.id ? 'Copied' : 'Copy body'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showView(v.id)}
                      style={{ ...buttonGhostStyle(), fontSize: 11, padding: '2px 6px' }}
                    >
                      {isViewing ? 'Hide body' : 'View body'}
                    </button>
                    {i > 0 ? (
                      <button
                        type="button"
                        onClick={() => void doRollback(v.id)}
                        disabled={rollbackPending || versions.length >= PERSONA_VERSION_MAX}
                        aria-label={`Restore this persona body to ${v.label || `v${versions.length - i}`} (${versionDate(v.createdAt)})`}
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
                  {isViewing && viewLoading ? (
                    <div style={{ color: teal.muted, fontSize: 12, padding: '0 8px 8px' }}>
                      Loading body…
                    </div>
                  ) : isViewing && viewError ? (
                    <p
                      role="alert"
                      style={{ color: ember.accent, fontSize: 12, padding: '0 8px 8px', margin: 0 }}
                    >
                      {viewError}
                    </p>
                  ) : isViewing && viewBody !== null ? (
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
                      {viewBody}
                    </pre>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {rollbackFeedback.error || rollbackFeedback.message ? (
          <p
            role={rollbackFeedback.error ? 'alert' : undefined}
            style={{
              color: rollbackFeedback.error ? ember.accent : teal.accent,
              fontSize: 13,
              margin: '8px 0 0',
            }}
          >
            {rollbackFeedback.error || rollbackFeedback.message}
          </p>
        ) : null}
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

export function PersonaForms({ personas, skillSlugs }: { personas: PersonaListItem[]; skillSlugs: string[] }) {
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
          <PersonaCard key={row.id} row={row} hasDefault={hasDefault} skillSlugs={skillSlugs} />
        ))
      )}
    </div>
  );
}
