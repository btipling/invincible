import { teal } from '../../../lib/palette';
import { createProdServices } from '../../../lib/di';
import { gateSettingsPage } from '../load';
import { SettingsPageShell } from '../SettingsPageShell';
import { McpForms, type McpListItem } from './McpForms';

/** Phase-1 DI: server component wires through the composition root. */
const services = createProdServices();

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'MCP servers · Settings · Invincible',
};

export default async function SettingsMcpPage() {
  const gate = await gateSettingsPage('/settings/mcp');
  return (
    <SettingsPageShell title="MCP servers" gate={gate}>
      {(ctx) => McpPageBody({ userId: ctx.userId })}
    </SettingsPageShell>
  );
}

async function McpPageBody({ userId }: { userId: string }) {
  const listed = await services.userMcpServers.listUserMcpServers(userId);
  if (!listed.ok) {
    return (
      <p role="alert" style={{ color: teal.muted, fontSize: 14 }}>
        {listed.code === 'unavailable'
          ? 'MCP servers are unavailable. If this is a new environment, run GitHub Actions workflow db-migrate (confirm=migrate).'
          : listed.error}
      </p>
    );
  }

  const servers: McpListItem[] = listed.value.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    url: r.url,
    authHeaderName: r.authHeaderName,
    enabled: r.enabled,
    hasApiKey: r.hasApiKey,
    apiKeyMask: r.apiKeyMask,
    lastError: r.lastError,
  }));

  return <McpForms servers={servers} />;
}
