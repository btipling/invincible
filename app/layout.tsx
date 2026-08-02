import type { ReactNode } from 'react';
import { teal } from '../lib/palette';

export const metadata = {
  title: 'Invincible',
  description: 'Prompt playground / agent harness via Vercel AI Gateway',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={{ height: '100%' }}>
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
          padding: 0,
          background: teal.bg,
          color: teal.text,
          height: '100%',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
