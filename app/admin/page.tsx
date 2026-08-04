import type { CSSProperties } from 'react';
import { auth } from '../../auth';
import { redirect } from 'next/navigation';
import { teal, warm, ember } from '../../lib/palette';
import { tenancyEnabled } from '../../lib/tenancy/enabled';
import { loadAdminContext } from '../../lib/tenancy/adminContext';
import { listUsersForAdmin } from '../../lib/tenancy/identity';
import { RotateTokenForm } from './rotate-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Admin · Invincible',
};

function panelStyle(): CSSProperties {
  return {
    background: teal.surface,
    border: `1px solid ${teal.border}`,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  };
}

function thStyle(): CSSProperties {
  return {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: `1px solid ${teal.border}`,
    color: teal.muted,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

function tdStyle(): CSSProperties {
  return {
    padding: '8px 10px',
    borderBottom: `1px solid ${teal.border}`,
    fontSize: 13,
    verticalAlign: 'top',
    wordBreak: 'break-word',
  };
}

export default async function AdminPage() {
  if (!tenancyEnabled()) {
    return (
      <main style={{ padding: 24, maxWidth: 880, margin: '0 auto', width: '100%' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>Admin</h1>
        <p style={{ color: teal.muted, margin: 0 }}>
          Tenancy is not enabled. Set <code style={{ color: warm.accent }}>DATABASE_URL</code>,{' '}
          <code style={{ color: warm.accent }}>AUTH_SECRET</code>, and{' '}
          <code style={{ color: warm.accent }}>CREDENTIALS_ENCRYPTION_KEY</code> to use admin.
        </p>
      </main>
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login?callbackUrl=/admin');
  }

  const result = await loadAdminContext(session.user.id);

  if (!result.ok) {
    const message =
      result.reason === 'forbidden'
        ? 'You do not have admin access for this tenant.'
        : result.reason === 'no_membership'
          ? 'No tenant membership found.'
          : result.reason === 'ambiguous'
            ? 'Multiple tenant memberships — v1 admin requires exactly one.'
            : 'Could not load admin data (database unavailable).';

    const hint =
      result.reason === 'forbidden' || result.reason === 'no_membership'
        ? 'Access denied — contact a tenant owner if you need admin.'
        : result.reason === 'ambiguous'
          ? 'v1 supports a single tenant membership per user.'
          : 'Check DATABASE_URL / pooler connectivity and try again.';

    return (
      <main style={{ padding: 24, maxWidth: 880, margin: '0 auto', width: '100%' }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>Admin</h1>
        <p role="alert" style={{ color: ember.accent, margin: 0 }}>
          {message}
        </p>
        <p style={{ color: teal.muted, fontSize: 14, marginTop: 12 }}>
          {hint}
        </p>
      </main>
    );
  }

  const { tenant, role, user, sandboxes, canRotate } = result.value;
  let roster: Awaited<ReturnType<typeof listUsersForAdmin>> = [];
  let rosterError: string | null = null;
  try {
    roster = await listUsersForAdmin();
  } catch {
    roster = [];
    rosterError = 'Could not load users (database unavailable).';
  }

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 960,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 650 }}>Admin</h1>
      <p style={{ margin: '0 0 20px', color: teal.muted, fontSize: 14 }}>
        Single-tenant view · signed in as{' '}
        <span style={{ color: teal.text }}>{user.email ?? user.id}</span>
      </p>

      <section style={panelStyle()} aria-labelledby="tenant-heading">
        <h2 id="tenant-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
          Tenant
        </h2>
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(100px, 140px) 1fr',
            gap: '8px 12px',
            fontSize: 14,
          }}
        >
          <dt style={{ color: teal.muted }}>Name</dt>
          <dd style={{ margin: 0 }}>{tenant.name}</dd>
          <dt style={{ color: teal.muted }}>Slug</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{tenant.slug}</dd>
          <dt style={{ color: teal.muted }}>Your role</dt>
          <dd style={{ margin: 0 }}>
            <span
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 4,
                background: warm.surface,
                border: `1px solid ${warm.border}`,
                color: warm.accent,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {role}
            </span>
          </dd>
        </dl>
      </section>

      <section style={panelStyle()} aria-labelledby="users-heading">
        <h2 id="users-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
          Users
        </h2>
        {rosterError ? (
          <p role="alert" style={{ color: ember.accent, margin: '0 0 12px', fontSize: 13 }}>
            {rosterError}
          </p>
        ) : null}
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead>
              <tr>
                <th style={thStyle()}>Email</th>
                <th style={thStyle()}>Status</th>
                <th style={thStyle()}>Source</th>
              </tr>
            </thead>
            <tbody>
              {roster.length === 0 ? (
                <tr>
                  <td style={tdStyle()} colSpan={3}>
                    <span style={{ color: rosterError ? ember.accent : teal.muted }}>
                      {rosterError ? 'User list unavailable.' : 'No users found.'}
                    </span>
                  </td>
                </tr>
              ) : (
                roster.map((u) => (
                  <tr key={u.id}>
                    <td style={tdStyle()}>
                      {u.email}
                      {u.name ? (
                        <span style={{ color: teal.muted, display: 'block', fontSize: 12 }}>
                          {u.name}
                        </span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        ...tdStyle(),
                        color: u.status === 'suspended' ? ember.accent : teal.text,
                      }}
                    >
                      {u.status}
                    </td>
                    <td style={tdStyle()}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          background: teal.bg,
                          border: `1px solid ${teal.border}`,
                          color: teal.accent,
                          fontSize: 12,
                          fontWeight: 600,
                          textTransform: 'lowercase',
                        }}
                      >
                        {u.provisionSource}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={panelStyle()} aria-labelledby="sandbox-heading">
        <h2 id="sandbox-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
          Sandboxes
        </h2>
        {sandboxes.length === 0 ? (
          <p style={{ margin: 0, color: teal.muted, fontSize: 14 }}>No sandboxes for this tenant.</p>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={thStyle()}>Name</th>
                  <th style={thStyle()}>Slug</th>
                  <th style={thStyle()}>Status</th>
                  <th style={thStyle()}>Base URL</th>
                  <th style={thStyle()}>Token</th>
                  <th style={thStyle()}>Grant</th>
                </tr>
              </thead>
              <tbody>
                {sandboxes.map((s) => (
                  <tr key={s.id}>
                    <td style={tdStyle()}>{s.name}</td>
                    <td style={{ ...tdStyle(), fontFamily: 'ui-monospace, monospace' }}>{s.slug}</td>
                    <td style={tdStyle()}>{s.status}</td>
                    <td style={{ ...tdStyle(), fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                      {s.baseUrl}
                    </td>
                    <td style={{ ...tdStyle(), fontFamily: 'ui-monospace, monospace' }}>
                      {s.tokenMasked}
                    </td>
                    <td style={tdStyle()}>
                      {s.canWrite ? 'read+write' : s.canRead ? 'read' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canRotate && sandboxes.length > 0
          ? sandboxes.map((s) => (
              <div
                key={`rotate-${s.id}`}
                style={{
                  marginTop: 16,
                  paddingTop: 12,
                  borderTop: `1px solid ${teal.border}`,
                }}
              >
                <div style={{ fontSize: 13, color: teal.muted, marginBottom: 4 }}>
                  Rotate token · <strong style={{ color: teal.text }}>{s.name}</strong>
                </div>
                <RotateTokenForm sandboxId={s.id} />
              </div>
            ))
          : null}

        {!canRotate ? (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: teal.muted }}>
            Token rotation is limited to the tenant owner.
          </p>
        ) : null}
      </section>

      <p style={{ margin: 0, fontSize: 12, color: teal.muted }}>
        User roster shows all provision sources (hybrid). SCIM HTTP is IdP-facing only.
      </p>
    </main>
  );
}
