'use client';

import { useActionState, type ReactNode } from 'react';
import { ember, teal } from '../../../lib/palette';
import {
  buttonPrimaryStyle,
  panelStyle,
} from '../ui';
import {
  selectSandboxAction,
  type SandboxSelectActionState,
} from './actions';

const initial: SandboxSelectActionState = {};

export type SandboxOptionView = {
  sandboxId: string;
  name: string;
  slug: string;
  backend: string;
  status: string;
  image: string | null;
  usable: boolean;
  granted: boolean;
};

export type SandboxPickerFormProps = {
  preferredSandboxId: string | null;
  options: SandboxOptionView[];
};

function Feedback({ state }: { state: SandboxSelectActionState }) {
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

function Badge({ children, tone }: { children: ReactNode; tone: 'ok' | 'muted' | 'warn' }) {
  const color =
    tone === 'ok' ? teal.accent : tone === 'warn' ? ember.accent : teal.muted;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 650,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '1px 8px',
        marginRight: 6,
      }}
    >
      {children}
    </span>
  );
}

export function SandboxPickerForm({
  preferredSandboxId,
  options,
}: SandboxPickerFormProps) {
  const [state, action, pending] = useActionState(selectSandboxAction, initial);

  if (options.length === 0) {
    return (
      <div style={panelStyle()}>
        <p style={{ margin: 0, color: teal.muted, fontSize: 14, lineHeight: 1.5 }}>
          No sandboxes available. An admin can create one under Admin → Sandboxes.
        </p>
      </div>
    );
  }

  return (
    <div style={panelStyle()}>
      <p style={{ margin: '0 0 14px', color: teal.muted, fontSize: 14, lineHeight: 1.5 }}>
        Choose which sandbox the harness agent uses for tools. When you have more than
        one usable grant, a selection is required. Admins can select a tenant sandbox
        they are not yet granted — that grants you read+write on it.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {options.map((opt) => {
          const selected = preferredSandboxId === opt.sandboxId;
          const disabled = pending || (opt.granted && !opt.usable);
          return (
            <li
              key={opt.sandboxId}
              style={{
                border: `1px solid ${selected ? teal.accent : teal.border}`,
                borderRadius: 10,
                padding: 14,
                background: teal.bg,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 14, color: teal.text }}>{opt.name}</strong>
                <code style={{ fontSize: 12, color: teal.muted }}>{opt.slug}</code>
                {selected ? <Badge tone="ok">Preferred</Badge> : null}
                <Badge tone="muted">{opt.backend}</Badge>
                <Badge tone={opt.status === 'active' ? 'ok' : 'warn'}>{opt.status}</Badge>
                {!opt.granted ? <Badge tone="muted">no grant yet</Badge> : null}
                {opt.granted && !opt.usable ? (
                  <Badge tone="warn">not usable</Badge>
                ) : null}
              </div>
              {opt.backend === 'vercel' ? (
                <p style={{ margin: '0 0 10px', fontSize: 12, color: teal.muted }}>
                  Image:{' '}
                  <code style={{ wordBreak: 'break-all' }}>
                    {opt.image?.trim() || 'default (universal)'}
                  </code>
                </p>
              ) : null}
              <form action={action}>
                <input type="hidden" name="sandboxId" value={opt.sandboxId} />
                <button
                  type="submit"
                  disabled={disabled || selected}
                  style={{
                    ...buttonPrimaryStyle(),
                    opacity: disabled || selected ? 0.55 : 1,
                    cursor: disabled || selected ? 'default' : 'pointer',
                  }}
                >
                  {selected
                    ? 'Selected'
                    : pending
                      ? 'Saving…'
                      : !opt.granted
                        ? 'Select & grant me access'
                        : 'Use this sandbox'}
                </button>
              </form>
            </li>
          );
        })}
      </ul>
      <Feedback state={state} />
      {!preferredSandboxId && options.filter((o) => o.usable).length > 1 ? (
        <p style={{ margin: '12px 0 0', color: ember.accent, fontSize: 13 }}>
          Multiple usable sandboxes — pick one before agent tools will work.
        </p>
      ) : null}
    </div>
  );
}
