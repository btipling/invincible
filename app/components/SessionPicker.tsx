'use client';

/**
 * Thin DOM host chrome: New session only. The session list lives in the Wasm
 * transcript rail. Hidden when the cloud repo is disabled (offline / Redis-off)
 * — local Clear remains the fallback. Transcript/composer stay in Wasm.
 */
import { warm } from '../../lib/palette';

export default function SessionPicker({
  hidden,
  disabled,
  onNew,
}: {
  /** Cloud repo disabled → hide entirely (local-only mode). */
  hidden: boolean;
  /** Interactions disabled (e.g. mid-turn) — control stays mounted to avoid reflow. */
  disabled: boolean;
  onNew: () => void;
}) {
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
