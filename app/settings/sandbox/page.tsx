import { teal } from '../../../lib/palette';
import { listUserSandboxChoices } from '../../../lib/tenancy/userPreferredSandbox';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import { SandboxPickerForm } from './SandboxPickerForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sandbox · Settings · Invincible',
};

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
  if (!listed.ok) {
    return (
      <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
        {listed.code === 'unavailable'
          ? 'Sandbox preference storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
          : listed.error}
      </p>
    );
  }

  return (
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
  );
}
