'use client';

/**
 * Phase-2 (#487) / Phase-3 (#488) — PersonaPicker: THIN DOM host chrome (like
 * SessionPicker), never a second chat panel / product surface.
 *
 * It fetches `GET /api/personas` summaries, projects them through the
 * client-safe `lib/personas.ts` helper (owned personas + single defaultId), and
 * renders a compact select with an explicit "None" option so a session can
 * start with no persona. It never receives a persona body (summaries only).
 *
 * Phase 3 (#488): wired into HarnessHost's New-session lifecycle. The controlled
 * `value` is:
 *   - `undefined` → "not explicitly chosen": preselect the default persona (or
 *     None when there is none) so New binds the default unless changed.
 *   - `string`   → an explicitly chosen persona id.
 *   - `null`     → explicitly chosen **None** (no persona, even if a default
 *     exists). This honors plan goal 2 ("explicit None").
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
  /** undefined = unbound (preselect default); string = chosen; null = explicit None. */
  value: string | null | undefined;
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
  // undefined → preselect the default (or None when no default exists) so the
  // control reflects what New will actually bind until the user changes it.
  const selectValue = value === undefined ? state.defaultId ?? '' : (value ?? '');

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
