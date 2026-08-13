/**
 * Server-authoritative, permission-aware tool-surface descriptor for the active
 * sandbox bind. Pure module — no I/O, no secrets, no model-prompt changes.
 *
 * Single source of truth for "what the active bind exposes", shared by the
 * inventory route (`GET /api/sandboxes` → `active.tools`) and future consumers
 * (#328 status chrome, #332 meta MCP). The model already sees the real tool
 * schemas via `createAgentTools`; this is a display/contract view only.
 */
import type { EffectivePermissions } from './grants';
import type { SandboxBackend } from './sandboxBackend';

export type SandboxToolSurface = {
  name: string;
  /** Permission family gating this tool (absent = always available). */
  requiresPermission?: 'read' | 'write';
  /** Backend-dependent caveat for the operator/status chrome. */
  note?: string;
};

/** Read-only bind surface (always present once a bind resolves). */
const READ_TOOLS: SandboxToolSurface[] = [
  { name: 'list_dir', requiresPermission: 'read' },
  { name: 'read_file', requiresPermission: 'read' },
  { name: 'stat', requiresPermission: 'read' },
];

/** Write bind surface — write implies read (effective permissions). */
const WRITE_TOOLS: SandboxToolSurface[] = [
  { name: 'write_file', requiresPermission: 'write' },
  { name: 'str_replace', requiresPermission: 'write' },
  {
    name: 'exec',
    requiresPermission: 'write',
    note:
      'command execution; argv-only (no shell) on both backends, stdin via exec body (per-backend caveats apply)',
  },
];

/** Always available on any bind (workspace navigation / cwd). */
const ALWAYS_TOOLS: SandboxToolSurface[] = [
  { name: 'change_dir' },
  { name: 'pwd' },
];

const BACKEND_NOTE: Record<SandboxBackend, { note: string }> = {
  vercel: { note: 'attach-only durable Workspace' },
  byo: { note: 'HTTP daemon v2' },
};

/**
 * Describe the tool surface of a bind for `backend` + effective permissions.
 * Read tools require `canRead`; write tools require `canWrite` (write implies
 * read); `change_dir`/`pwd` are always present. Deterministic order.
 */
export function describeSandboxTools(
  backend: SandboxBackend,
  permissions: Pick<EffectivePermissions, 'canRead' | 'canWrite'>,
): SandboxToolSurface[] {
  const { note } = BACKEND_NOTE[backend];
  const out: SandboxToolSurface[] = [];

  if (permissions.canWrite) {
    for (const t of WRITE_TOOLS) {
      // exec keeps its own argv/stdin caveat; the other write tools are
      // described with the backend note only.
      const noteForTool =
        t.name === 'exec' ? `${t.note}; ${note}` : note;
      out.push({ ...t, note: noteForTool });
    }
  }
  if (permissions.canRead) {
    for (const t of READ_TOOLS) {
      out.push({ ...t, note });
    }
  }
  out.push(...ALWAYS_TOOLS);
  return out;
}
