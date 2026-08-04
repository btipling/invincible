import { teal } from '../../../lib/palette';
import { gateAdminPage } from '../load';
import { AdminPageShell } from '../AdminPageShell';
import { RotateDekForm } from '../rotate-dek-form';
import { panelStyle } from '../ui';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Encryption · Admin · Invincible' };

export default async function AdminEncryptionPage() {
  const gate = await gateAdminPage();
  return (
    <AdminPageShell title="Encryption" gate={gate}>
      {(ctx) => (
        <section style={panelStyle()} aria-labelledby="dek-heading">
          <h2 id="dek-heading" style={{ margin: '0 0 8px', fontSize: 16 }}>
            Tenant encryption (DEK)
          </h2>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: teal.muted }}>
            Owner-only. Rotates the per-tenant data encryption key (DEK) and re-encrypts{' '}
            <strong style={{ color: teal.text }}>
              sandbox tokens and provider secret credentials
            </strong>
            . Application master key (AMK) is unchanged. Never shows key material.
          </p>
          {ctx.canRotate ? (
            <RotateDekForm tenantId={ctx.tenant.id} />
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: teal.muted }}>
              Only the tenant owner can rotate the DEK.
            </p>
          )}
        </section>
      )}
    </AdminPageShell>
  );
}
