import { MCP_TOOL_NAME_MAX } from './limits';

/**
 * Sanitize a remote MCP tool name for AI SDK / provider tool keys.
 * Returns null when empty after sanitize.
 */
export function sanitizeMcpToolName(raw: string): string | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return null;
  return s.slice(0, MCP_TOOL_NAME_MAX);
}

/**
 * Final tool key: `mcp_<slug>__<sanitizedRemote>`.
 * Returns null if remote name sanitizes empty.
 */
export function mcpToolKey(slug: string, remoteName: string): string | null {
  const safe = sanitizeMcpToolName(remoteName);
  if (!safe) return null;
  const s = String(slug ?? '').trim();
  if (!s) return null;
  return `mcp_${s}__${safe}`;
}

/** System addendum when any mcp_ tools are present (phase 2 lock). */
export const MCP_SYSTEM_ADDENDUM =
  'External MCP tools may be available; their names are prefixed with mcp_.';
