'use client';

/**
 * Phase 3 (#415) — SessionPicker: THIN DOM host chrome, never a second chat panel.
 * Lists the caller's sessions from `GET /api/sessions` **summaries** (no transcripts)
 * and lets the user switch (host hydrates Wasm) or start a New session. Hidden when the
 * cloud repo is disabled (offline / tenancy-off / Redis-off) — the host then falls back
 * to today's plain local Clear. feature-divide: transcript/composer stay in Wasm.
 */
import { teal, warm } from '../../lib/palette';
import type { SessionSummary } from '../../lib/sessionRepository';

function labelFor(session: SessionSummary): string {
  if (session.title && session.title.trim()) return session.title.trim();
  // Summaries carry no transcript (by design), so a title-less session can't show a
  // first-message snippet here — but it MUST still be distinguishable from its peers,
  // else a list of untitled sessions is unusable. Show a short server-id suffix.
  const short = session.id.length > 8 ? `…${session.id.slice(-7)}` : session.id;
  return `Untitled · ${short}`;
}

export default function SessionPicker({
  sessions,
  currentId,
  hidden,
  disabled,
  onNew,
  onSwitch,
}: {
  sessions: SessionSummary[];
  currentId: string | null;
  /** Cloud repo disabled → hide entirely (local-only mode). Never a layout surprise. */
  hidden: boolean;
  /** Interactions disabled (e.g. mid-turn) — control stays mounted to avoid reflow. */
  disabled: boolean;
  onNew: () => void;
  onSwitch: (id: string) => void;
}) {
  // Cloud repo disabled → hide the picker entirely (local-only mode). No error panel;
  // no dual-chat surface. It stays mounted while `disabled` (busy) so nav doesn't reflow.
  if (hidden) return null;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        flexWrap: 'nowrap',
      }}
    >
      <select
        aria-label="Switch session"
        value={currentId ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next) onSwitch(next);
        }}
        style={{
          appearance: 'auto',
          fontSize: '0.72rem',
          padding: '0.2rem 0.4rem',
          maxWidth: 180,
          borderRadius: 4,
          background: 'transparent',
          border: `1px solid ${teal.border}`,
          color: teal.text,
        }}
      >
        <option value="" disabled>
          Switch session…
        </option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {labelFor(s)}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onNew}
        disabled={disabled}
        title="Start a new session"
        style={{
          appearance: 'none',
          borderRadius: 4,
          fontWeight: 600,
          fontSize: '0.72rem',
          padding: '0.2rem 0.5rem',
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: 'transparent',
          border: `1px solid ${warm.border}`,
          color: warm.accent,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        New session
      </button>
    </span>
  );
}
