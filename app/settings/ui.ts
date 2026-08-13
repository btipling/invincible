import type { CSSProperties } from 'react';
import { teal } from '../../lib/palette';

export const SETTINGS_SIDEBAR_WIDTH = 220;

export function panelStyle(): CSSProperties {
  return {
    background: teal.surface,
    border: `1px solid ${teal.border}`,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
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

export const SETTINGS_NAV = [
  { href: '/settings', label: 'Overview', exact: true },
  { href: '/settings/mcp', label: 'MCP servers', exact: false },
  { href: '/settings/github', label: 'GitHub token', exact: false },
  { href: '/settings/personas', label: 'Personas', exact: false },
  { href: '/settings/sandbox', label: 'Sandbox', exact: false },
] as const;
