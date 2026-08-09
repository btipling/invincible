import { teal } from '../../../lib/palette';
import { listUserSandboxChoices } from '../../../lib/tenancy/userPreferredSandbox';
import {
  loadInstance,
  reconcileStatus,
  type UserSandboxPurpose,
} from '../../../lib/tenancy/userSandboxInstance';
import type { UserSandboxInstance } from '../../../db';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import {
  SandboxInstanceCards,
  type InstanceView,
} from './SandboxInstanceCards';
import { SandboxPickerForm } from './SandboxPickerForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sandbox · Settings · Invincible',
};

function toView(
  purpose: UserSandboxPurpose,
  row: UserSandboxInstance | null,
  reconcileWarning?: string | null,
): InstanceView {
  if (!row) {
    return {
      exists: false,
      purpose,
      status: null,
      image: null,
      lastError: null,
      updatedAt: null,
      vercelName: null,
      reconcileWarning: null,
    };
  }
  return {
    exists: true,
    purpose,
    status: row.status,
    image: row.image,
    lastError: row.lastError,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    vercelName: row.vercelName,
    reconcileWarning: reconcileWarning ?? null,
  };
}

async function loadInstanceView(
  userId: string,
  purpose: UserSandboxPurpose,
): Promise<InstanceView> {
  const loaded = await loadInstance(userId, purpose);
  if (!loaded.ok) {
    return {
      exists: false,
      purpose,
      status: null,
      image: null,
      lastError: null,
      updatedAt: null,
      vercelName: null,
      reconcileWarning: loaded.error,
    };
  }
  if (!loaded.value) {
    return toView(purpose, null);
  }

  const reconciled = await reconcileStatus(userId, purpose);
  if (reconciled.ok) {
    return toView(purpose, reconciled.value);
  }

  // Keep last known row; surface non-blocking warning.
  return toView(
    purpose,
    loaded.value,
    reconciled.error || 'Could not refresh status from platform; showing last known state.',
  );
}

export default async function SettingsSandboxPage() {
  const gate = await gateSettingsPage('/settings/sandbox');
  return (
    <SettingsPageShell title="Sandbox" gate={gate}>
      {(ctx) => SandboxPageBody({ userId: ctx.userId })}
    </SettingsPageShell>
  );
}

async function SandboxPageBody({ userId }: { userId: string }) {
  const listed = await listUserSandboxChoices(userId);
  const [workspace, http] = await Promise.all([
    loadInstanceView(userId, 'workspace'),
    loadInstanceView(userId, 'http'),
  ]);

  return (
    <>
      <section style={{ marginBottom: 8 }}>
        <h2
          style={{
            margin: '0 0 10px',
            fontSize: 16,
            color: teal.text,
            fontWeight: 650,
          }}
        >
          Catalog preference
        </h2>
        {!listed.ok ? (
          <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
            {listed.code === 'unavailable'
              ? 'Sandbox preference storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
              : listed.error}
          </p>
        ) : (
          <SandboxPickerForm
            preferredSandboxId={listed.value.preferredSandboxId}
            options={listed.value.options.map((o) => ({
              sandboxId: o.sandboxId,
              name: o.name,
              slug: o.slug,
              backend: o.backend,
              status: o.status,
              image: o.image,
              usable: o.usable,
              granted: o.granted,
            }))}
          />
        )}
      </section>

      <section style={{ marginTop: 8 }}>
        <h2
          style={{
            margin: '0 0 10px',
            fontSize: 16,
            color: teal.text,
            fontWeight: 650,
          }}
        >
          Your instances
        </h2>
        <p style={{ margin: '0 0 12px', color: teal.muted, fontSize: 13, lineHeight: 1.5 }}>
          Durable Vercel Sandbox VMs you control. The agent only attaches — it never
          creates instances on a turn.
        </p>
        <SandboxInstanceCards workspace={workspace} http={http} />
      </section>
    </>
  );
}
