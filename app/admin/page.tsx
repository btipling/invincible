import Link from 'next/link';
import { teal, warm } from '../../lib/palette';
import { createProdServices } from '../../lib/di';
import type { AdminContext } from '../../lib/tenancy/adminContext';
import { gateAdminPage } from './load';
import { AdminPageShell } from './AdminPageShell';
import { panelStyle } from './ui';

/** Phase-1 DI: server component wires through the composition root. */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Admin · Invincible',
};

export default async function AdminOverviewPage() {
  const gate = await gateAdminPage();
  return (
    <AdminPageShell title="Overview" gate={gate}>
      {(ctx) => OverviewBody({ ctx })}
    </AdminPageShell>
  );
}

async function OverviewBody({ ctx }: { ctx: AdminContext }) {
  let userCount = 0;
  let secretCount: number | null = null;
  let secretsError: string | null = null;
  try {
    const roster = await services.identity.listUsersForAdmin();
    userCount = roster.length;
  } catch {
    userCount = 0;
  }
  const secrets = await services.providerSecrets.listProviderSecretsForAdmin(
    ctx.tenant.id,
  );
  if (secrets.ok) {
    secretCount = secrets.value.length;
  } else {
    secretsError =
      'Inference keys unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).';
  }

  const cards = [
    { href: '/admin/users', label: 'Users', value: String(userCount), note: 'Hybrid roster' },
    {
      href: '/admin/sandboxes',
      label: 'Sandboxes',
      value: String(ctx.sandboxes.length),
      note: ctx.canRotate ? 'Owner can rotate tokens' : 'Read-only token rotate',
    },
    {
      href: '/admin/inference',
      label: 'Inference keys',
      value: secretCount == null ? '—' : String(secretCount),
      note: secretsError ? 'Setup needed' : 'BYOK provider secrets',
    },
    {
      href: '/admin/encryption',
      label: 'Encryption',
      value: ctx.canRotate ? 'Owner' : 'Admin',
      note: 'Tenant DEK rotate',
    },
  ];

  return (
    <>
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
          <dd style={{ margin: 0 }}>{ctx.tenant.name}</dd>
          <dt style={{ color: teal.muted }}>Slug</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{ctx.tenant.slug}</dd>
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
              {ctx.role}
            </span>
          </dd>
        </dl>
      </section>

      {secretsError ? (
        <p role="alert" style={{ color: warm.accent, fontSize: 13, margin: '0 0 16px' }}>
          {secretsError}
        </p>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            style={{
              ...panelStyle(),
              marginBottom: 0,
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
            }}
          >
            <div style={{ fontSize: 12, color: teal.muted, fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, margin: '8px 0 4px', color: teal.accent }}>
              {c.value}
            </div>
            <div style={{ fontSize: 12, color: teal.muted }}>{c.note}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
