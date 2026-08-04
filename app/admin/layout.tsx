import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import AppNav from '../components/AppNav';
import { AuthNavLinks } from '../components/AuthNavLinks';
import { teal } from '../../lib/palette';
import { AdminNav } from './AdminNav';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin · Invincible',
  description: 'Tenant and sandbox admin',
};

export default function AdminLayout({ children }: { children: ReactNode }) {
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
        {/* Mobile nav strip */}
        <div className="admin-layout-mobile">
          <AdminNav mode="mobile" />
        </div>
        <div
          className="admin-layout-body"
          style={{
            flex: 1,
            display: 'flex',
            minHeight: 0,
            minWidth: 0,
          }}
        >
          <div className="admin-layout-sidebar">
            <AdminNav mode="desktop" />
          </div>
          <div style={{ flex: 1, minWidth: 0, width: '100%' }}>{children}</div>
        </div>
      </div>
      <style>{`
        .admin-layout-mobile { display: none; }
        .admin-layout-sidebar { display: none; }
        @media (max-width: 767px) {
          .admin-layout-mobile { display: block; }
          .admin-layout-sidebar { display: none; }
          .admin-layout-body { flex-direction: column; }
        }
        @media (min-width: 768px) {
          .admin-layout-mobile { display: none; }
          .admin-layout-sidebar { display: block; }
          .admin-layout-body { flex-direction: row; }
        }
      `}</style>
    </div>
  );
}
