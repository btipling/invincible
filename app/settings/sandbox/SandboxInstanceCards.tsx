'use client';

import { useActionState, type ReactNode } from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  panelStyle,
} from '../ui';
import {
  createInstanceAction,
  destroyInstanceAction,
  startInstanceAction,
  stopInstanceAction,
  type SandboxInstanceActionState,
} from './actions';

const initial: SandboxInstanceActionState = {};

export type InstanceView = {
  exists: boolean;
  purpose: 'workspace' | 'http';
  status: string | null;
  image: string | null;
  lastError: string | null;
  updatedAt: string | null;
  vercelName: string | null;
  reconcileWarning?: string | null;
};

function Feedback({ state }: { state: SandboxInstanceActionState }) {
  if (state.error) {
    return (
      <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '10px 0 0' }}>
        {state.error}
      </p>
    );
  }
  if (state.ok && state.message) {
    return (
      <p style={{ color: teal.accent, fontSize: 13, margin: '10px 0 0' }}>
        {state.message}
      </p>
    );
  }
  return null;
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'ok' | 'muted' | 'warn';
}) {
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

function statusTone(status: string | null): 'ok' | 'muted' | 'warn' {
  if (status === 'running') return 'ok';
  if (status === 'error') return 'warn';
  return 'muted';
}

function ActionButton({
  label,
  pendingLabel,
  pending,
  disabled,
  variant,
}: {
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  variant: 'primary' | 'ghost';
}) {
  const style = variant === 'primary' ? buttonPrimaryStyle() : buttonGhostStyle();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      style={{
        ...style,
        opacity: disabled || pending ? 0.55 : 1,
        cursor: disabled || pending ? 'default' : 'pointer',
      }}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function InstanceCard({ view }: { view: InstanceView }) {
  const [createState, createAction, createPending] = useActionState(
    createInstanceAction,
    initial,
  );
  const [startState, startAction, startPending] = useActionState(
    startInstanceAction,
    initial,
  );
  const [stopState, stopAction, stopPending] = useActionState(
    stopInstanceAction,
    initial,
  );
  const [destroyState, destroyAction, destroyPending] = useActionState(
    destroyInstanceAction,
    initial,
  );

  const busy =
    createPending || startPending || stopPending || destroyPending;
  const status = view.status;
  const canCreate = !view.exists;
  const canStart =
    view.exists && (status === 'stopped' || status === 'error');
  const canStop = view.exists && status === 'running';
  const canDestroy = view.exists;

  const title =
    view.purpose === 'workspace' ? 'Workspace instance' : 'HTTP / curl instance';
  const emptyCopy =
    view.purpose === 'workspace'
      ? 'Agent tools will not create a Workspace for you. Create one here after choosing a vercel catalog sandbox above (set preferred when you have multiple grants).'
      : 'Used for builtin http_get / http_head. The agent never creates this automatically.';

  const latestError =
    destroyState.error ||
    stopState.error ||
    startState.error ||
    createState.error;
  const latestOk =
    (!latestError &&
      (destroyState.ok
        ? destroyState
        : stopState.ok
          ? stopState
          : startState.ok
            ? startState
            : createState.ok
              ? createState
              : null)) ||
    null;

  return (
    <div style={panelStyle()}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, color: teal.text, fontWeight: 650 }}>
          {title}
        </h2>
        {view.exists && status ? (
          <Badge tone={statusTone(status)}>{status}</Badge>
        ) : (
          <Badge tone="muted">not created</Badge>
        )}
      </div>

      <p style={{ margin: '0 0 12px', color: teal.muted, fontSize: 13, lineHeight: 1.5 }}>
        {view.exists
          ? 'Idle auto-stop ~30 minutes without use. Stop or Destroy anytime.'
          : emptyCopy}
      </p>

      {view.reconcileWarning ? (
        <p role="status" style={{ color: warm.accent, fontSize: 13, margin: '0 0 10px' }}>
          {view.reconcileWarning}
        </p>
      ) : null}

      {view.exists ? (
        <dl
          style={{
            margin: '0 0 14px',
            display: 'grid',
            gap: 6,
            fontSize: 13,
            color: teal.muted,
          }}
        >
          <div>
            <dt style={{ display: 'inline', fontWeight: 600, color: teal.text }}>
              Image:{' '}
            </dt>
            <dd style={{ display: 'inline', margin: 0 }}>
              <code style={{ wordBreak: 'break-all' }}>{view.image ?? '—'}</code>
            </dd>
          </div>
          <div>
            <dt style={{ display: 'inline', fontWeight: 600, color: teal.text }}>
              Name:{' '}
            </dt>
            <dd style={{ display: 'inline', margin: 0 }}>
              <code style={{ wordBreak: 'break-all' }}>{view.vercelName ?? '—'}</code>
            </dd>
          </div>
          {view.updatedAt ? (
            <div>
              <dt style={{ display: 'inline', fontWeight: 600, color: teal.text }}>
                Updated:{' '}
              </dt>
              <dd style={{ display: 'inline', margin: 0 }}>
                {new Date(view.updatedAt).toLocaleString()}
              </dd>
            </div>
          ) : null}
          {view.lastError ? (
            <div>
              <dt
                style={{
                  display: 'inline',
                  fontWeight: 600,
                  color: ember.accent,
                }}
              >
                Last error:{' '}
              </dt>
              <dd
                style={{ display: 'inline', margin: 0, color: ember.accent }}
                role="alert"
              >
                {view.lastError}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {canCreate ? (
          <form action={createAction}>
            <input type="hidden" name="purpose" value={view.purpose} />
            <ActionButton
              label="Create"
              pendingLabel="Creating…"
              pending={createPending}
              disabled={busy && !createPending}
              variant="primary"
            />
          </form>
        ) : null}

        {canStart ? (
          <form action={startAction}>
            <input type="hidden" name="purpose" value={view.purpose} />
            <ActionButton
              label="Start"
              pendingLabel="Starting…"
              pending={startPending}
              disabled={busy && !startPending}
              variant="primary"
            />
          </form>
        ) : null}

        {canStop ? (
          <form action={stopAction}>
            <input type="hidden" name="purpose" value={view.purpose} />
            <ActionButton
              label="Stop"
              pendingLabel="Stopping…"
              pending={stopPending}
              disabled={busy && !stopPending}
              variant="ghost"
            />
          </form>
        ) : null}

        {canDestroy ? (
          <form
            action={destroyAction}
            onSubmit={(e) => {
              const label =
                view.purpose === 'workspace' ? 'Workspace' : 'HTTP/curl';
              if (
                !window.confirm(
                  `Destroy this ${label} instance? The platform VM will be deleted and the registry row removed. This cannot be undone (you can Create again later).`,
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="purpose" value={view.purpose} />
            <ActionButton
              label="Destroy"
              pendingLabel="Destroying…"
              pending={destroyPending}
              disabled={busy && !destroyPending}
              variant="ghost"
            />
          </form>
        ) : null}
      </div>

      {createPending ? (
        <p style={{ margin: '10px 0 0', color: teal.muted, fontSize: 13 }}>
          Creating may take 30–60 seconds…
        </p>
      ) : null}

      {latestError ? (
        <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '10px 0 0' }}>
          {latestError}
        </p>
      ) : latestOk ? (
        <Feedback state={latestOk} />
      ) : null}
    </div>
  );
}

export function SandboxInstanceCards({
  workspace,
  http,
}: {
  workspace: InstanceView;
  http: InstanceView;
}) {
  return (
    <>
      <InstanceCard view={workspace} />
      <InstanceCard view={http} />
    </>
  );
}
