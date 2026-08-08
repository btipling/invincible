import { teal } from '../../../lib/palette';
import { gateAdminPage } from '../load';
import { AdminPageShell } from '../AdminPageShell';
import { RotateTokenForm } from '../rotate-form';
import { panelStyle, tdStyle, thStyle } from '../ui';
import { CreateSandboxForm, EditSandboxForm } from './SandboxForms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sandboxes · Admin · Invincible' };

export default async function AdminSandboxesPage() {
  const gate = await gateAdminPage('/admin/sandboxes');
  return (
    <AdminPageShell title="Sandboxes" gate={gate}>
      {(ctx) => {
        const { sandboxes, canRotate } = ctx;
        return (
          <>
            <section style={panelStyle()} aria-labelledby="sandbox-heading">
              <h2 id="sandbox-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
                Sandboxes
              </h2>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: teal.muted }}>
                Each sandbox chooses its own backend (BYO daemon or Vercel Sandbox) and, for
                Vercel, an image. There is no host-wide backend env switch.
              </p>
              {sandboxes.length === 0 ? (
                <p style={{ margin: 0, color: teal.muted, fontSize: 14 }}>
                  No sandboxes for this tenant.
                </p>
              ) : (
                <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th style={thStyle()}>Name</th>
                        <th style={thStyle()}>Slug</th>
                        <th style={thStyle()}>Status</th>
                        <th style={thStyle()}>Backend</th>
                        <th style={thStyle()}>Image</th>
                        <th style={thStyle()}>Base URL</th>
                        <th style={thStyle()}>Token</th>
                        <th style={thStyle()}>Grant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sandboxes.map((s) => (
                        <tr key={s.id}>
                          <td style={tdStyle()}>{s.name}</td>
                          <td style={{ ...tdStyle(), fontFamily: 'ui-monospace, monospace' }}>
                            {s.slug}
                          </td>
                          <td style={tdStyle()}>{s.status}</td>
                          <td style={tdStyle()}>{s.backend}</td>
                          <td
                            style={{
                              ...tdStyle(),
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 12,
                            }}
                          >
                            {s.imageLabel}
                          </td>
                          <td
                            style={{
                              ...tdStyle(),
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 12,
                            }}
                          >
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
                ? sandboxes
                    .filter((s) => s.backend === 'byo')
                    .map((s) => (
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

              {canRotate && sandboxes.every((s) => s.backend !== 'byo') && sandboxes.length > 0 ? (
                <p style={{ margin: '12px 0 0', fontSize: 12, color: teal.muted }}>
                  Token rotation applies to BYO sandboxes only.
                </p>
              ) : null}

              {!canRotate ? (
                <p style={{ margin: '12px 0 0', fontSize: 12, color: teal.muted }}>
                  Token rotation is limited to the tenant owner.
                </p>
              ) : null}
            </section>

            <CreateSandboxForm />

            {sandboxes.map((s) => (
              <EditSandboxForm key={`edit-${s.id}`} sandbox={s} />
            ))}
          </>
        );
      }}
    </AdminPageShell>
  );
}
