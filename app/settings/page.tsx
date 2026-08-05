import Link from 'next/link';
import { teal, warm } from '../../lib/palette';
import { gateSettingsPage } from './load';
import { SettingsPageShell } from './SettingsPageShell';
import { panelStyle } from './ui';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Settings · Invincible',
};

export default async function SettingsOverviewPage() {
  const gate = await gateSettingsPage('/settings');
  return (
    <SettingsPageShell title="Settings" gate={gate}>
      {() => (
        <div style={panelStyle()}>
          <p style={{ margin: '0 0 12px', color: teal.muted, fontSize: 14, lineHeight: 1.5 }}>
            Manage your personal configuration. MCP servers are unique to your account —
            they are not shared with other tenant members and are not managed under Admin.
          </p>
          <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5 }}>
            Add remote HTTPS MCP endpoints (optional API-key header). Enabled servers
            contribute tools to agent turns under the{' '}
            <code style={{ color: warm.accent }}>mcp_*</code> prefix.
          </p>
          <Link
            href="/settings/mcp"
            style={{
              display: 'inline-block',
              padding: '8px 14px',
              borderRadius: 8,
              border: `1px solid ${teal.accentDark}`,
              background: teal.accentDark,
              color: teal.bg,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            MCP servers
          </Link>
        </div>
      )}
    </SettingsPageShell>
  );
}
