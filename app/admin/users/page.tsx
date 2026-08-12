import { ember, teal } from '../../../lib/palette';
import { createProdServices } from '../../../lib/di';
import { gateAdminPage } from '../load';
import { AdminPageShell } from '../AdminPageShell';
import { panelStyle, tdStyle, thStyle } from '../ui';

/** Phase-1 DI: server component wires through the composition root. */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Users · Admin · Invincible' };

export default async function AdminUsersPage() {
  const gate = await gateAdminPage('/admin/users');
  return (
    <AdminPageShell title="Users" gate={gate}>
      {async () => {
        let roster: Awaited<ReturnType<typeof services.identity.listUsersForAdmin>> =
          [];
        let rosterError: string | null = null;
        try {
          roster = await services.identity.listUsersForAdmin();
        } catch {
          roster = [];
          rosterError = 'Could not load users (database unavailable).';
        }

        return (
          <section style={panelStyle()} aria-labelledby="users-heading">
            <h2 id="users-heading" style={{ margin: '0 0 12px', fontSize: 16 }}>
              Hybrid roster
            </h2>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: teal.muted }}>
              All provision sources (credentials, OIDC, SCIM). SCIM HTTP is IdP-facing only.
            </p>
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
        );
      }}
    </AdminPageShell>
  );
}
