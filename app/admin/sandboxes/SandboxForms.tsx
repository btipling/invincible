'use client';

import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { ember, teal } from '../../../lib/palette';
import { VERCEL_SANDBOX_IMAGE_PRESETS } from '../../../lib/tenancy/sandboxBackend';
import {
  createSandboxAction,
  updateSandboxAction,
  type SandboxActionState,
} from '../actions';
import {
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';

type SandboxRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  backend: string;
  image: string | null;
  imageLabel: string;
  baseUrl: string;
  tokenMasked: string;
  canRead: boolean;
  canWrite: boolean;
};

const initial: SandboxActionState = {};

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
      <span style={{ display: 'block', marginBottom: 4, color: teal.muted, fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function ImageFields({
  backend,
  initialImage,
}: {
  backend: string;
  initialImage?: string | null;
}) {
  if (backend !== 'vercel') return null;

  const stored = initialImage?.trim() || '';
  const presetMatch = VERCEL_SANDBOX_IMAGE_PRESETS.some((p) =>
    p.value === null ? !stored : p.value === stored,
  );
  const startMode = !stored || presetMatch ? 'preset' : 'custom';
  const [mode, setMode] = useState(startMode);
  const [preset, setPreset] = useState(() => {
    if (!stored) return '';
    const hit = VERCEL_SANDBOX_IMAGE_PRESETS.find((p) => p.value === stored);
    return hit ? (hit.value ?? '') : '';
  });

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, color: teal.muted, fontWeight: 600, marginBottom: 4 }}>
        Image
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 13, color: teal.text }}>
          <input
            type="radio"
            name="imageMode"
            value="preset"
            checked={mode === 'preset'}
            onChange={() => setMode('preset')}
          />{' '}
          Managed preset
        </label>
        <label style={{ fontSize: 13, color: teal.text }}>
          <input
            type="radio"
            name="imageMode"
            value="custom"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
          />{' '}
          Custom VCR / VMI ref
        </label>
      </div>
      {mode === 'preset' ? (
        <select
          name="imagePreset"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          style={inputStyle()}
        >
          {VERCEL_SANDBOX_IMAGE_PRESETS.map((p) => (
            <option key={p.label} value={p.value ?? ''}>
              {p.label}
              {p.value ? ` (${p.value})` : ''}
            </option>
          ))}
        </select>
      ) : (
        <input
          name="imageCustom"
          type="text"
          defaultValue={startMode === 'custom' ? stored : ''}
          placeholder="team/project/repo:tag"
          style={{ ...inputStyle(), fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          autoComplete="off"
        />
      )}
      <p style={{ margin: '6px 0 0', fontSize: 12, color: teal.muted }}>
        Blank / default stores null — runtime uses vercel/sandbox/universal:latest. Image must be
        reachable by the host Vercel project (not built by this app).
      </p>
    </div>
  );
}

function BackendFields({
  backend,
  onBackend,
  initialBaseUrl,
  initialImage,
  showTokenHint,
}: {
  backend: string;
  onBackend: (b: string) => void;
  initialBaseUrl?: string;
  initialImage?: string | null;
  showTokenHint?: string;
}) {
  return (
    <>
      <Field label="Backend">
        <select
          name="backend"
          value={backend}
          onChange={(e) => onBackend(e.target.value)}
          style={inputStyle()}
        >
          <option value="byo">BYO daemon (URL + token)</option>
          <option value="vercel">Vercel Sandbox (ephemeral VM)</option>
        </select>
      </Field>
      {backend === 'byo' ? (
        <>
          <Field label="Base URL">
            <input
              name="baseUrl"
              type="url"
              defaultValue={initialBaseUrl && initialBaseUrl !== '—' ? initialBaseUrl : ''}
              required
              placeholder="https://sandbox.example.com"
              style={inputStyle()}
              autoComplete="off"
            />
          </Field>
          <Field label={showTokenHint ?? 'Token'}>
            <input
              name="token"
              type="password"
              autoComplete="new-password"
              style={inputStyle()}
              {...(showTokenHint ? {} : { required: true })}
            />
          </Field>
        </>
      ) : (
        <ImageFields backend={backend} initialImage={initialImage} />
      )}
    </>
  );
}

export function CreateSandboxForm() {
  const [state, action, pending] = useActionState(createSandboxAction, initial);
  const [backend, setBackend] = useState('byo');

  return (
    <section style={panelStyle()} aria-labelledby="create-sandbox-heading">
      <h2 id="create-sandbox-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
        Create sandbox
      </h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: teal.muted }}>
        Creates an active sandbox and grants you read+write. Existing grants are kept — pick the active workspace under Settings → Sandbox when you have more than one.
      </p>
      <form action={action}>
        <Field label="Name">
          <input name="name" type="text" required style={inputStyle()} autoComplete="off" />
        </Field>
        <Field label="Slug">
          <input
            name="slug"
            type="text"
            required
            pattern="[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
            placeholder="default"
            style={{ ...inputStyle(), fontFamily: 'ui-monospace, monospace' }}
            autoComplete="off"
          />
        </Field>
        <BackendFields backend={backend} onBackend={setBackend} />
        {state.error ? (
          <p style={{ color: ember.accent, fontSize: 13, margin: '0 0 12px' }} role="alert">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p style={{ color: teal.accent, fontSize: 13, margin: '0 0 12px' }}>Sandbox created.</p>
        ) : null}
        <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
          {pending ? 'Creating…' : 'Create sandbox'}
        </button>
      </form>
    </section>
  );
}

export function EditSandboxForm({ sandbox }: { sandbox: SandboxRow }) {
  const [state, action, pending] = useActionState(updateSandboxAction, initial);
  const [backend, setBackend] = useState(sandbox.backend === 'vercel' ? 'vercel' : 'byo');

  useEffect(() => {
    setBackend(sandbox.backend === 'vercel' ? 'vercel' : 'byo');
  }, [sandbox.id, sandbox.backend]);

  return (
    <section
      style={{
        ...panelStyle(),
        marginTop: 12,
      }}
      aria-labelledby={`edit-sandbox-${sandbox.id}`}
    >
      <h3 id={`edit-sandbox-${sandbox.id}`} style={{ margin: '0 0 12px', fontSize: 14 }}>
        Edit · {sandbox.name}
      </h3>
      <form action={action}>
        <input type="hidden" name="sandboxId" value={sandbox.id} />
        <Field label="Name">
          <input
            name="name"
            type="text"
            required
            defaultValue={sandbox.name}
            style={inputStyle()}
            autoComplete="off"
          />
        </Field>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: teal.muted }}>
          Slug <code style={{ fontFamily: 'ui-monospace, monospace' }}>{sandbox.slug}</code> (fixed)
        </p>
        <BackendFields
          key={`${sandbox.id}-${backend}`}
          backend={backend}
          onBackend={setBackend}
          initialBaseUrl={sandbox.baseUrl}
          initialImage={sandbox.image}
          showTokenHint="New token (leave blank to keep)"
        />
        {sandbox.backend === 'byo' && backend === 'vercel' ? (
          <p style={{ color: ember.accent, fontSize: 12, margin: '0 0 12px' }} role="status">
            Switching to Vercel clears the stored BYO URL and token ciphertext. Save only if you
            intend to drop BYO credentials for this row.
          </p>
        ) : null}
        {state.error && state.sandboxId === sandbox.id ? (
          <p style={{ color: ember.accent, fontSize: 13, margin: '0 0 12px' }} role="alert">
            {state.error}
          </p>
        ) : null}
        {state.ok && state.sandboxId === sandbox.id ? (
          <p style={{ color: teal.accent, fontSize: 13, margin: '0 0 12px' }}>Saved.</p>
        ) : null}
        <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </section>
  );
}
