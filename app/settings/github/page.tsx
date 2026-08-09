import { teal } from '../../../lib/palette';
import { getUserGithubTokenStatus } from '../../../lib/tenancy/userGithubToken';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import { GithubTokenForm } from './GithubTokenForm';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'GitHub token · Settings · Invincible',
};

export default async function SettingsGithubPage() {
  const gate = await gateSettingsPage('/settings/github');
  return (
    <SettingsPageShell title="GitHub token" gate={gate}>
      {(ctx) => GithubPageBody({ userId: ctx.userId })}
    </SettingsPageShell>
  );
}

async function GithubPageBody({ userId }: { userId: string }) {
  const status = await getUserGithubTokenStatus(userId);
  if (!status.ok) {
    return (
      <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
        {status.code === 'unavailable'
          ? 'GitHub token storage is unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
          : status.error}
      </p>
    );
  }

  return (
    <GithubTokenForm
      configured={status.value.configured}
      updatedAt={
        status.value.updatedAt
          ? status.value.updatedAt.toISOString()
          : null
      }
    />
  );
}
