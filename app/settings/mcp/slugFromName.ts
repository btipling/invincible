import { MCP_SLUG_RE } from '../../../lib/mcp/limits';

/** Derive a slug candidate from a display name (client or tests). */
export function slugFromName(name: string): string {
  let s = name.trim().toLowerCase();
  s = s.replace(/[^a-z0-9_]+/g, '_');
  s = s.replace(/_+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  if (!s) return 's';
  if (!/^[a-z]/.test(s)) {
    s = `s${s}`;
  }
  s = s.slice(0, 32);
  s = s.replace(/_+$/g, '');
  if (!MCP_SLUG_RE.test(s)) {
    // last resort
    const cleaned = s.replace(/[^a-z0-9_]/g, '').slice(0, 32);
    if (MCP_SLUG_RE.test(cleaned)) return cleaned;
    return 's';
  }
  return s;
}
