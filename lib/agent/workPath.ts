/**
 * Workspace-relative path helpers for agent tools (logical cwd).
 * Pure TS — no daemon I/O. Jail-escape is lexical only; the sandbox daemon
 * still enforces the real jail.
 */

export class WorkPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkPathError';
  }
}

/** C0 controls + DEL — break tool-result lines, annotations, and SSE framing. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalize a workspace-relative path.
 * Rejects host-absolute paths, null bytes / control characters; collapses `.` / `..`.
 * Empty / whitespace → `"."`.
 */
export function normalizeWorkspaceRel(userPath: string): string {
  if (typeof userPath !== 'string') {
    throw new WorkPathError('Path must be a string');
  }
  if (CONTROL_CHARS.test(userPath)) {
    throw new WorkPathError('Path contains control characters');
  }

  let rel = userPath.replace(/\\/g, '/').trim();
  if (rel === '') return '.';

  // Host-absolute / UNC / Windows drive
  if (rel.startsWith('/')) {
    throw new WorkPathError('Host-absolute paths are not allowed');
  }
  if (rel.startsWith('//')) {
    throw new WorkPathError('Host-absolute paths are not allowed');
  }
  if (/^[a-zA-Z]:/.test(rel)) {
    throw new WorkPathError('Host-absolute paths are not allowed');
  }

  const parts = rel.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length === 0) {
        throw new WorkPathError('Path escapes workspace root');
      }
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.length === 0 ? '.' : out.join('/');
}

/**
 * Prefix-aware resolve: join `path` under logical `cwd`, unless `path` is
 * already workspace-root-relative under/equal to cwd (model copied tool results).
 *
 * Paths with leading `..` are joined under cwd first (so `change_dir ..` works).
 */
export function resolveAgainstCwd(cwd: string, path: string): string {
  const c = normalizeWorkspaceRel(cwd || '.');
  let raw = path == null || path === '' ? '.' : String(path);
  if (CONTROL_CHARS.test(raw)) {
    throw new WorkPathError('Path contains control characters');
  }
  raw = raw.replace(/\\/g, '/').trim();
  if (raw === '') raw = '.';

  // Host-absolute on the arg before join
  if (raw.startsWith('/') || raw.startsWith('//') || /^[a-zA-Z]:/.test(raw)) {
    throw new WorkPathError('Host-absolute paths are not allowed');
  }

  // Prefix-aware: only when path normalizes alone without escaping root
  let nAlone: string | null = null;
  try {
    nAlone = normalizeWorkspaceRel(raw);
  } catch {
    nAlone = null;
  }
  if (
    nAlone != null &&
    c !== '.' &&
    (nAlone === c || nAlone.startsWith(`${c}/`))
  ) {
    return nAlone;
  }

  if (c === '.') {
    // May throw if path escapes (e.g. `..` at root)
    return normalizeWorkspaceRel(raw);
  }
  if (nAlone === '.') return c;
  // Join raw (not pre-normalized) so `..` segments apply under cwd
  return normalizeWorkspaceRel(`${c}/${raw}`);
}

/** Resolve exec cwd field; omit/empty → logical cwd. */
export function resolveExecCwd(
  logicalCwd: string,
  execCwd?: string | null,
): string {
  if (execCwd == null || String(execCwd).trim() === '') {
    return normalizeWorkspaceRel(logicalCwd || '.');
  }
  return resolveAgainstCwd(logicalCwd, execCwd);
}

/** ` cwd=invincible` or empty when cwd is `.`. */
export function formatCwdAnnotation(cwd: string): string {
  try {
    const c = normalizeWorkspaceRel(cwd || '.');
    return c === '.' ? '' : ` cwd=${c}`;
  } catch {
    return '';
  }
}

/**
 * Normalize initial request/session cwd.
 * Returns `{ ok: true, cwd }` or `{ ok: false, error }` for route 400.
 */
export function parseInitialCwd(
  cwd: unknown,
): { ok: true; cwd: string } | { ok: false; error: string } {
  if (cwd === undefined || cwd === null) {
    return { ok: true, cwd: '.' };
  }
  if (typeof cwd !== 'string') {
    return { ok: false, error: 'Field "cwd" must be a string.' };
  }
  try {
    return { ok: true, cwd: normalizeWorkspaceRel(cwd) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid cwd: ${msg}` };
  }
}
