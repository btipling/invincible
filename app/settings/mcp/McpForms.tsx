'use client';

import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import { MAX_MCP_SERVERS_PER_USER } from '../../../lib/mcp/limits';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';
import {
  createMcpServerAction,
  deleteMcpServerAction,
  testMcpServerAction,
  toggleMcpServerAction,
  updateMcpServerAction,
  type McpActionState,
} from './actions';
import { slugFromName } from './slugFromName';

export type McpListItem = {
  id: string;
  name: string;
  slug: string;
  url: string;
  authHeaderName: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMask: string | null;
  lastError: string | null;
};

const initial: McpActionState = {};

const HEADER_PRESETS = [
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'Authorization', label: 'Authorization (Bearer)' },
  { value: '__custom__', label: 'Custom…' },
] as const;

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

function ActionFeedback({ state }: { state: McpActionState }) {
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

function HeaderNameFields({
  defaultName,
}: {
  defaultName: string | null;
}) {
  const initial =
    !defaultName
      ? 'x-api-key'
      : defaultName === 'x-api-key' || defaultName === 'Authorization'
        ? defaultName
        : '__custom__';
  const [mode, setMode] = useState(initial);
  const customDefault =
    initial === '__custom__' ? defaultName ?? '' : '';

  return (
    <>
      <Field label="Auth header name">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          style={inputStyle()}
        >
          {HEADER_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {mode === '__custom__' ? (
        <Field label="Custom header name">
          <input
            name="authHeaderName"
            type="text"
            defaultValue={customDefault}
            autoComplete="off"
            placeholder="X-Custom-Key"
            style={inputStyle()}
          />
        </Field>
      ) : (
        <input type="hidden" name="authHeaderName" value={mode} />
      )}
    </>
  );
}

function CreateForm({ atLimit }: { atLimit: boolean }) {
  const [state, action, pending] = useActionState(createMcpServerAction, initial);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    if (!slugTouched) {
      setSlug(slugFromName(name));
    }
  }, [name, slugTouched]);

  if (atLimit) {
    return (
      <div style={panelStyle()}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Add MCP server</h2>
        <p style={{ color: teal.muted, fontSize: 13, margin: 0 }}>
          Limit of {MAX_MCP_SERVERS_PER_USER} servers reached. Delete one to add
          another.
        </p>
      </div>
    );
  }

  return (
    <form action={action} style={panelStyle()}>
      <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>Add MCP server</h2>
      <Field label="Name">
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
      <Field label="Slug" hint="Tool prefix: mcp_<slug>__…">
        <input
          name="slug"
          type="text"
          required
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          autoComplete="off"
          style={inputStyle()}
        />
      </Field>
      <Field label="URL" hint="HTTPS MCP endpoint only">
        <input
          name="url"
          type="url"
          required
          placeholder="https://mcp.example.com/mcp"
          autoComplete="off"
          style={inputStyle()}
        />
      </Field>
      <HeaderNameFields defaultName="x-api-key" />
      <Field label="API key" hint="Optional — leave empty for public HTTPS MCP">
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          style={inputStyle()}
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
        <input name="enabled" type="checkbox" defaultChecked value="on" />
        <span>Enabled for agent turns</span>
      </label>
      <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
        {pending ? 'Saving…' : 'Add server'}
      </button>
      <ActionFeedback state={state} />
    </form>
  );
}

function ServerCard({ row }: { row: McpListItem }) {
  const [editState, editAction, editPending] = useActionState(
    updateMcpServerAction,
    initial,
  );
  const [delState, delAction, delPending] = useActionState(
    deleteMcpServerAction,
    initial,
  );
  const [testState, testAction, testPending] = useActionState(
    testMcpServerAction,
    initial,
  );
  const [toggleState, toggleAction, togglePending] = useActionState(
    toggleMcpServerAction,
    initial,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

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
        <code style={{ color: warm.accent, fontSize: 12 }}>mcp_{row.slug}__…</code>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: row.enabled ? teal.accent : teal.muted,
          }}
        >
          {row.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {row.lastError ? (
        <p
          role="status"
          style={{
            color: ember.accent,
            fontSize: 13,
            margin: '0 0 12px',
            wordBreak: 'break-word',
          }}
        >
          Last error: {row.lastError}
        </p>
      ) : null}

      <form action={editAction}>
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
        <Field label="Slug">
          <input
            name="slug"
            type="text"
            required
            defaultValue={row.slug}
            autoComplete="off"
            style={inputStyle()}
          />
        </Field>
        <Field label="URL">
          <input
            name="url"
            type="url"
            required
            defaultValue={row.url}
            autoComplete="off"
            style={inputStyle()}
          />
        </Field>
        <HeaderNameFields defaultName={row.authHeaderName} />
        <Field
          label="API key"
          hint={
            row.hasApiKey
              ? `Saved key: ${row.apiKeyMask ?? '********'} — leave blank to keep`
              : 'Optional'
          }
        >
          <input
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={row.hasApiKey ? 'Leave blank to keep' : undefined}
            style={inputStyle()}
          />
        </Field>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="submit" disabled={editPending} style={buttonPrimaryStyle()}>
            {editPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        <ActionFeedback state={editState} />
      </form>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${teal.border}`,
        }}
      >
        <form action={testAction}>
          <input type="hidden" name="id" value={row.id} />
          <button type="submit" disabled={testPending} style={buttonGhostStyle()}>
            {testPending ? 'Testing…' : 'Test connection'}
          </button>
        </form>
        <form action={toggleAction}>
          <input type="hidden" name="id" value={row.id} />
          <input
            type="hidden"
            name="enabled"
            value={row.enabled ? 'false' : 'true'}
          />
          <button type="submit" disabled={togglePending} style={buttonGhostStyle()}>
            {togglePending
              ? '…'
              : row.enabled
                ? 'Disable'
                : 'Enable'}
          </button>
        </form>
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
      <ActionFeedback state={testState} />
      <ActionFeedback state={toggleState} />
      <ActionFeedback state={delState} />
    </div>
  );
}

export function McpForms({ servers }: { servers: McpListItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <CreateForm atLimit={servers.length >= MAX_MCP_SERVERS_PER_USER} />
      {servers.length === 0 ? (
        <p style={{ color: teal.muted, fontSize: 14 }}>
          No MCP servers yet. Add a remote HTTPS endpoint above.
        </p>
      ) : (
        servers.map((row) => <ServerCard key={row.id} row={row} />)
      )}
    </div>
  );
}
