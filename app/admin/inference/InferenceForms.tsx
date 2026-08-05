'use client';

import { useActionState, useMemo, useState, type ReactNode } from 'react';
import { ember, teal, warm } from '../../../lib/palette';
import {
  BYOK_PROVIDER_DEFS,
  SUGGESTED_MODELS,
  byokCredentialShape,
  type ByokProvider,
} from '../../../lib/gateway/byokProviders';
import {
  createProviderSecretAction,
  disableProviderSecretAction,
  enableProviderSecretAction,
  setProviderSecretGrantsAction,
  setProviderSecretModelsAction,
  updateProviderSecretAction,
  type InferenceActionState,
} from '../actions';
import {
  buttonGhostStyle,
  buttonPrimaryStyle,
  inputStyle,
  panelStyle,
} from '../ui';

type Member = { userId: string; email: string; role: string; status: string };
type SecretRow = {
  id: string;
  name: string;
  provider: string;
  status: string;
  credentialMask: string;
  modelIds: string[];
  grants: { userId: string; canUse: boolean }[];
  updatedAt: string;
};

const initial: InferenceActionState = {};

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

function CredentialFields({ provider }: { provider: ByokProvider }) {
  const shape = byokCredentialShape(provider);
  if (shape === 'apiKey') {
    return (
      <Field label="API key">
        <input name="apiKey" type="password" autoComplete="off" required style={inputStyle()} />
      </Field>
    );
  }
  if (shape === 'azure') {
    return (
      <>
        <Field label="API key">
          <input name="apiKey" type="password" autoComplete="off" required style={inputStyle()} />
        </Field>
        <Field label="Resource name">
          <input name="resourceName" type="text" required style={inputStyle()} />
        </Field>
      </>
    );
  }
  if (shape === 'vertex') {
    return (
      <>
        <Field label="Project">
          <input name="project" type="text" required style={inputStyle()} />
        </Field>
        <Field label="Location">
          <input name="location" type="text" required style={inputStyle()} placeholder="us-central1" />
        </Field>
        <Field label="Client email">
          <input name="clientEmail" type="text" required style={inputStyle()} />
        </Field>
        <Field label="Private key">
          <textarea
            name="privateKey"
            required
            rows={4}
            style={{ ...inputStyle(), fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
        </Field>
      </>
    );
  }
  // bedrock
  return (
    <>
      <Field label="Access key ID">
        <input name="accessKeyId" type="text" required style={inputStyle()} />
      </Field>
      <Field label="Secret access key">
        <input
          name="secretAccessKey"
          type="password"
          autoComplete="off"
          required
          style={inputStyle()}
        />
      </Field>
      <Field label="Region (optional)">
        <input name="region" type="text" style={inputStyle()} placeholder="us-east-1" />
      </Field>
    </>
  );
}

function ActionError({ state }: { state: InferenceActionState }) {
  if (!state.error) return null;
  return (
    <p role="alert" style={{ color: ember.accent, fontSize: 13, margin: '0 0 12px' }}>
      {state.error}
    </p>
  );
}

export function CreateSecretForm({ members }: { members: Member[] }) {
  const [provider, setProvider] = useState<ByokProvider>('xai');
  const [state, action, pending] = useActionState(createProviderSecretAction, initial);
  const suggestions = SUGGESTED_MODELS[provider] ?? [];

  return (
    <section style={panelStyle()} aria-labelledby="create-secret-heading">
      <h2 id="create-secret-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
        Add inference key
      </h2>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: teal.muted }}>
        Credentials are encrypted under the tenant DEK. Creating a key does{' '}
        <strong style={{ color: teal.text }}>not</strong> auto-grant anyone — select grants
        explicitly (including yourself).
      </p>
      <ActionError state={state} />
      {state.ok ? (
        <p style={{ color: teal.accent, fontSize: 13, margin: '0 0 12px' }}>
          Secret created (key not shown).
        </p>
      ) : null}
      <form action={action}>
        <Field label="Name">
          <input name="name" type="text" required maxLength={80} style={inputStyle()} />
        </Field>
        <Field label="Provider">
          <select
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ByokProvider)}
            style={inputStyle()}
          >
            {BYOK_PROVIDER_DEFS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.id})
              </option>
            ))}
          </select>
        </Field>
        <CredentialFields provider={provider} />
        <Field label="Model ids (comma or space separated)">
          <input
            name="modelIds"
            type="text"
            style={inputStyle()}
            placeholder={suggestions[0] ?? `${provider}/model-name`}
          />
        </Field>
        <p style={{ margin: '-4px 0 12px', fontSize: 12, color: teal.muted }}>
          Gateway format is <code style={{ fontSize: 11 }}>provider/model</code>{' '}
          (e.g. <code style={{ fontSize: 11 }}>xai/grok-4.5</code>). Bare names
          like <code style={{ fontSize: 11 }}>grok-4.5</code> are prefixed with{' '}
          <code style={{ fontSize: 11 }}>{provider}/</code>.
        </p>
        {suggestions.length > 0 ? (
          <p style={{ margin: '-4px 0 12px', fontSize: 12, color: teal.muted }}>
            Suggested: {suggestions.join(', ')}
          </p>
        ) : null}
        <fieldset style={{ border: `1px solid ${teal.border}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <legend style={{ color: teal.muted, fontSize: 12, fontWeight: 600, padding: '0 6px' }}>
            Grants (can_use)
          </legend>
          {members.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: teal.muted }}>No tenant members.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {members.map((m) => (
                <label key={m.userId} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
                  <input type="checkbox" name="grantUserIds" value={m.userId} />
                  <span>
                    {m.email}{' '}
                    <span style={{ color: teal.muted }}>
                      ({m.role}
                      {m.status !== 'active' ? ` · ${m.status}` : ''})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <button type="submit" disabled={pending} style={buttonPrimaryStyle()}>
          {pending ? 'Saving…' : 'Create key'}
        </button>
      </form>
    </section>
  );
}

export function SecretCard({
  secret,
  members,
}: {
  secret: SecretRow;
  members: Member[];
}) {
  const [modelsState, modelsAction, modelsPending] = useActionState(
    setProviderSecretModelsAction,
    initial,
  );
  const [grantsState, grantsAction, grantsPending] = useActionState(
    setProviderSecretGrantsAction,
    initial,
  );
  const [disableState, disableAction, disablePending] = useActionState(
    disableProviderSecretAction,
    initial,
  );
  const [enableState, enableAction, enablePending] = useActionState(
    enableProviderSecretAction,
    initial,
  );
  const [updateState, updateAction, updatePending] = useActionState(
    updateProviderSecretAction,
    initial,
  );
  const [replaceKey, setReplaceKey] = useState(false);
  const provider = (isByok(secret.provider) ? secret.provider : 'anthropic') as ByokProvider;
  const granted = useMemo(
    () => new Set(secret.grants.filter((g) => g.canUse).map((g) => g.userId)),
    [secret.grants],
  );

  return (
    <section style={panelStyle()} aria-labelledby={`secret-${secret.id}`}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 12,
        }}
      >
        <div>
          <h3 id={`secret-${secret.id}`} style={{ margin: 0, fontSize: 16 }}>
            {secret.name}
          </h3>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Badge>{secret.provider}</Badge>
            <Badge tone={secret.status === 'active' ? 'ok' : 'warn'}>{secret.status}</Badge>
            <span style={{ fontSize: 12, color: teal.muted, fontFamily: 'ui-monospace, monospace' }}>
              {secret.credentialMask}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: teal.muted }}>
          {secret.modelIds.length} models · {secret.grants.filter((g) => g.canUse).length} grants
          <div>Updated {secret.updatedAt}</div>
        </div>
      </div>

      <ActionError state={modelsState} />
      <ActionError state={grantsState} />
      <ActionError state={disableState} />
      <ActionError state={enableState} />
      <ActionError state={updateState} />

      <form action={modelsAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="secretId" value={secret.id} />
        <Field label="Models">
          <input
            name="modelIds"
            type="text"
            defaultValue={secret.modelIds.join(', ')}
            style={inputStyle()}
          />
        </Field>
        <button type="submit" disabled={modelsPending} style={buttonGhostStyle()}>
          {modelsPending ? 'Saving…' : 'Save models'}
        </button>
      </form>

      <form action={grantsAction} style={{ marginBottom: 12 }}>
        <input type="hidden" name="secretId" value={secret.id} />
        <fieldset style={{ border: `1px solid ${teal.border}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <legend style={{ color: teal.muted, fontSize: 12, fontWeight: 600, padding: '0 6px' }}>
            Grants
          </legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {members.map((m) => (
              <label key={m.userId} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  name="grantUserIds"
                  value={m.userId}
                  defaultChecked={granted.has(m.userId)}
                />
                <span>{m.email}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={grantsPending} style={buttonGhostStyle()}>
          {grantsPending ? 'Saving…' : 'Save grants'}
        </button>
      </form>

      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: 'pointer', color: teal.accent, fontSize: 13, fontWeight: 600 }}>
          Edit name / replace key
        </summary>
        <form action={updateAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="secretId" value={secret.id} />
          <input type="hidden" name="provider" value={secret.provider} />
          <Field label="Name">
            <input name="name" type="text" defaultValue={secret.name} style={inputStyle()} />
          </Field>
          <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 12, alignItems: 'center' }}>
            <input
              type="checkbox"
              name="replaceKey"
              value="1"
              checked={replaceKey}
              onChange={(e) => setReplaceKey(e.target.checked)}
            />
            Replace credentials
          </label>
          {replaceKey ? <CredentialFields provider={provider} /> : null}
          <button type="submit" disabled={updatePending} style={buttonPrimaryStyle()}>
            {updatePending ? 'Saving…' : 'Update'}
          </button>
        </form>
      </details>

      {secret.status === 'active' ? (
        <form action={disableAction}>
          <input type="hidden" name="secretId" value={secret.id} />
          <button type="submit" disabled={disablePending} style={{ ...buttonGhostStyle(), color: ember.accent, borderColor: ember.border }}>
            {disablePending ? '…' : 'Disable'}
          </button>
        </form>
      ) : (
        <form action={enableAction}>
          <input type="hidden" name="secretId" value={secret.id} />
          <button type="submit" disabled={enablePending} style={buttonGhostStyle()}>
            {enablePending ? '…' : 'Re-enable'}
          </button>
        </form>
      )}
    </section>
  );
}

function isByok(p: string): p is ByokProvider {
  return BYOK_PROVIDER_DEFS.some((d) => d.id === p);
}

function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  const colors =
    tone === 'ok'
      ? { bg: teal.bg, border: teal.accent, color: teal.accent }
      : tone === 'warn'
        ? { bg: warm.surface, border: warm.border, color: warm.accent }
        : { bg: teal.bg, border: teal.border, color: teal.accent };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        color: colors.color,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'lowercase',
      }}
    >
      {children}
    </span>
  );
}
