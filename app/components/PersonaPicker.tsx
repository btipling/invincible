'use client';

/**
 * Phase-2 (#487) — PersonaPicker: THIN DOM host chrome (like SessionPicker),
 * never a second chat panel / product surface.
 *
 * The picker SOURCE for Phase 3: it fetches `GET /api/personas` summaries,
 * projects them through the client-safe `lib/personas.ts` helper (owned
 * personas + single defaultId), and renders a compact select with an explicit
 * "None" option so a session can start with no persona. It never receives a
 * persona body (summaries only).
 *
 * Phase 3 (HarnessHost + New-session lifecycle) wires this into the session
 * picker. Per plan DoD, HarnessHost is NOT touched this phase — the component
 * ships standalone here.
 */
import { useEffect, useState } from 'react';
import { teal } from '../../lib/palette';
import { personaLabel, personaPickerState, type PersonaOption } from '../../lib/personas';

type PersonaResponse = { personas: PersonaOption[] };

export default function PersonaPicker({
  value,
  onChange,
  disabled,
}: {
  /** Currently selected persona id (null = "None"). */
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<PersonaOption[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/personas', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = (await res.json()) as PersonaResponse;
        if (cancelled) return;
        setOptions(Array.isArray(data.personas) ? data.personas : []);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const state = personaPickerState(options);
  const selectValue = value ?? '';

  if (status === 'error') {
    return (
      <span
        style={{
          fontSize: '0.72rem',
          color: teal.muted,
          border: `1px solid ${teal.border}`,
          borderRadius: 4,
          padding: '0.2rem 0.4rem',
        }}
      >
        Personas unavailable
      </span>
    );
  }

  return (
    <select
      aria-label="Persona"
      value={selectValue}
      disabled={disabled || status === 'loading'}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
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
      <option value="">None</option>
      {state.options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name.trim() || personaLabel(o)}
          {o.isDefault ? ' · default' : ''}
        </option>
      ))}
    </select>
  );
}
