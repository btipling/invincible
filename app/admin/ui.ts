import type { CSSProperties } from 'react';
import { teal } from '../../lib/palette';

export const ADMIN_SIDEBAR_WIDTH = 220;

export function panelStyle(): CSSProperties {
  return {
    background: teal.surface,
    border: `1px solid ${teal.border}`,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  };
}

export function thStyle(): CSSProperties {
  return {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: `1px solid ${teal.border}`,
    color: teal.muted,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

export function tdStyle(): CSSProperties {
  return {
    padding: '8px 10px',
    borderBottom: `1px solid ${teal.border}`,
    fontSize: 13,
    verticalAlign: 'top',
    wordBreak: 'break-word',
  };
}

export function inputStyle(): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${teal.border}`,
    background: teal.bg,
    color: teal.text,
    fontSize: 14,
  };
}

export function buttonPrimaryStyle(): CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: `1px solid ${teal.accentDark}`,
    background: teal.accentDark,
    color: teal.bg,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

export function buttonGhostStyle(): CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: `1px solid ${teal.border}`,
    background: 'transparent',
    color: teal.text,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

export const ADMIN_NAV = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/users', label: 'Users', exact: false },
  { href: '/admin/sandboxes', label: 'Sandboxes', exact: false },
  { href: '/admin/inference', label: 'Inference', exact: false },
  { href: '/admin/encryption', label: 'Encryption', exact: false },
] as const;
