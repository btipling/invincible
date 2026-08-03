'use client';
import type { ReactNode } from 'react';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { teal, warm } from '../../lib/palette';

const links = [
  { href: '/', label: 'Playground' },
  { href: '/harness', label: 'Harness' },
] as const;

const focusRing = `0 0 0 2px ${teal.bg}, 0 0 0 4px ${teal.accent}`;

export default function AppNav({ right }: { right?: ReactNode }) {
  const pathname = usePathname();

  return (
    <header
      style={{
        borderBottom: `1px solid ${teal.border}`,
        background: teal.surface,
        padding: '0.85rem 1.25rem',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.75rem 1rem',
      }}
    >
      <Link
        href="/"
        style={{
          margin: 0,
          fontSize: '1.15rem',
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: teal.text,
          textDecoration: 'none',
          borderRadius: 4,
          outline: 'none',
        }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = focusRing;
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        Invincible
      </Link>
      <nav aria-label="Primary" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
        {links.map((l) => {
          const active =
            l.href === '/'
              ? pathname === '/'
              : pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? 'page' : undefined}
              style={{
                fontSize: '0.85rem',
                textDecoration: 'none',
                color: active ? teal.accent : teal.muted,
                border: `1px solid ${active ? teal.accent : teal.border}`,
                background: active ? teal.bg : 'transparent',
                borderRadius: 4,
                padding: '0.25rem 0.6rem',
                fontWeight: active ? 600 : 400,
                outline: 'none',
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = focusRing;
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      {right ? (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {right}
        </div>
      ) : (
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '0.75rem',
            color: warm.muted,
          }}
        />
      )}
    </header>
  );
}
