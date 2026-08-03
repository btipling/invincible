import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import AppNav from '../components/AppNav';
import { AuthNavLinks } from '../components/AuthNavLinks';
import { teal } from '../../lib/palette';

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
      {children}
    </div>
  );
}
