import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import AppNav from '../components/AppNav';
import { AuthNavLinks } from '../components/AuthNavLinks';
import { teal } from '../../lib/palette';
import { SettingsNav } from './SettingsNav';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings · Invincible',
  description: 'User settings — MCP servers and GitHub token',
};

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: teal.bg,
        color: teal.text,
      }}
    >
      <AppNav right={<AuthNavLinks />} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <div className="settings-layout-mobile">
          <SettingsNav mode="mobile" />
        </div>
        <div
          className="settings-layout-body"
          style={{
            flex: 1,
            display: 'flex',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          <div className="settings-layout-sidebar">
            <SettingsNav mode="desktop" />
          </div>
          <div style={{ flex: 1, minWidth: 0, width: '100%' }}>{children}</div>
        </div>
      </div>
      <style>{`
        .settings-layout-mobile { display: none; }
        .settings-layout-sidebar { display: none; }
        @media (max-width: 767px) {
          .settings-layout-mobile { display: block; }
          .settings-layout-sidebar { display: none; }
          .settings-layout-body { flex-direction: column; }
        }
        @media (min-width: 768px) {
          .settings-layout-mobile { display: none; }
          .settings-layout-sidebar { display: block; }
          .settings-layout-body { flex-direction: row; }
        }
      `}</style>
    </div>
  );
}
