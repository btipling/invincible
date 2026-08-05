import { ember, teal } from '../../../lib/palette';
import { listProviderSecretsForAdmin } from '../../../lib/tenancy/providerSecrets';
import { listTenantMembersForAdmin } from '../../../lib/tenancy/listTenantMembers';
import { gateAdminPage } from '../load';
import { AdminPageShell } from '../AdminPageShell';
import { CreateSecretForm, SecretCard } from './InferenceForms';
import { panelStyle } from '../ui';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Inference · Admin · Invincible' };

export default async function AdminInferencePage() {
  const gate = await gateAdminPage('/admin/inference');
  return (
    <AdminPageShell title="Inference keys" gate={gate}>
      {async (ctx) => {
        let members: Awaited<ReturnType<typeof listTenantMembersForAdmin>> = [];
        let membersError: string | null = null;
        try {
          members = await listTenantMembersForAdmin(ctx.tenant.id);
        } catch {
          membersError = 'Could not load tenant members.';
        }

        const secrets = await listProviderSecretsForAdmin(ctx.tenant.id);
        if (!secrets.ok) {
          return (
            <section style={panelStyle()}>
              <p role="alert" style={{ color: ember.accent, margin: 0, fontSize: 14 }}>
                {secrets.error === 'could not list secrets'
                  ? 'Could not load inference keys. If tables are missing, run GitHub Actions workflow db-migrate (confirm=migrate).'
                  : secrets.error}
              </p>
            </section>
          );
        }

        const memberRows = members.map((m) => ({
          userId: m.userId,
          email: m.email,
          role: m.role,
          status: m.status,
        }));

        const secretRows = secrets.value.map((s) => ({
          id: s.id,
          name: s.name,
          provider: s.provider,
          status: s.status,
          credentialMask: s.credentialMask,
          modelIds: s.modelIds,
          grants: s.grants,
          updatedAt:
            s.updatedAt instanceof Date
              ? s.updatedAt.toISOString().slice(0, 19).replace('T', ' ')
              : String(s.updatedAt),
        }));

        return (
          <>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: teal.muted }}>
              Bring-your-own provider keys for tenancy-on inference. Masked preview only — full
              keys are never shown after save. Vercel AI Gateway still requires{' '}
              <strong style={{ color: teal.text }}>paid team AI credits</strong> for BYOK (free
              tier rejects request-scoped keys); top up in the Vercel dashboard if harness returns
              a paid-credits error.
            </p>
            {membersError ? (
              <p role="alert" style={{ color: ember.accent, fontSize: 13 }}>
                {membersError}
              </p>
            ) : null}

            <CreateSecretForm members={memberRows} />

            {secretRows.length === 0 ? (
              <section style={panelStyle()}>
                <p style={{ margin: 0, color: teal.muted, fontSize: 14 }}>
                  No inference keys yet. Add one above, then grant members so they appear in the
                  harness catalog.
                </p>
              </section>
            ) : (
              secretRows.map((s) => (
                <SecretCard key={s.id} secret={s} members={memberRows} />
              ))
            )}
          </>
        );
      }}
    </AdminPageShell>
  );
}
