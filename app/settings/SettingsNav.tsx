'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { teal } from '../../lib/palette';
import { SETTINGS_NAV, SETTINGS_SIDEBAR_WIDTH } from './ui';

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SettingsNav({ mode }: { mode: 'desktop' | 'mobile' }) {
  const pathname = usePathname() || '/settings';
  const [open, setOpen] = useState(false);

  if (mode === 'mobile') {
    return (
      <div
        style={{
          display: 'flex',
          borderBottom: `1px solid ${teal.border}`,
          background: teal.surface,
          padding: '8px 12px',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="settings-mobile-nav"
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${teal.border}`,
            background: teal.bg,
            color: teal.text,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Menu
        </button>
        <span style={{ color: teal.muted, fontSize: 13 }}>Settings</span>
        {open ? (
          <nav
            id="settings-mobile-nav"
            aria-label="Settings sections"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              width: '100%',
            }}
          >
            {SETTINGS_NAV.map((item) => {
              const active = isActive(pathname, item.href, item.exact);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: `1px solid ${active ? teal.accent : teal.border}`,
                    background: active ? teal.bg : 'transparent',
                    color: active ? teal.accent : teal.text,
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <aside
      style={{
        width: SETTINGS_SIDEBAR_WIDTH,
        flexShrink: 0,
        height: '100%',
        borderRight: `1px solid ${teal.border}`,
        background: teal.surface,
        padding: '16px 0',
        boxSizing: 'border-box',
      }}
      aria-label="Settings sections"
    >
      <div
        style={{
          padding: '0 16px 12px',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: teal.muted,
        }}
      >
        Settings
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {SETTINGS_NAV.map((item) => {
          const active = isActive(pathname, item.href, item.exact);
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: 'block',
                padding: '10px 16px',
                borderLeft: `3px solid ${active ? teal.accent : 'transparent'}`,
                background: active ? teal.bg : 'transparent',
                color: active ? teal.accent : teal.text,
                fontSize: 14,
                fontWeight: active ? 650 : 500,
                textDecoration: 'none',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
