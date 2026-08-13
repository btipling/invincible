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
 * Normalize a workspace root `R` (the per-binding jail root).
 * Requires a non-empty absolute POSIX path; trailing slashes are stripped.
 * Used only as a prefix for lexical abs↔rel canonicalization (never realpath).
 */
function normalizeWorkspaceRoot(R: string): string {
  if (typeof R !== 'string') {
    throw new WorkPathError('Workspace root must be a path string');
  }
  if (CONTROL_CHARS.test(R)) {
    throw new WorkPathError('Workspace root contains control characters');
  }
  let root = R.replace(/\\/g, '/').trim();
  if (!root.startsWith('/')) {
    throw new WorkPathError('Workspace root must be an absolute path');
  }
  return root.replace(/\/+$/, '') || '/';
}

/**
 * Convert a host-absolute path `abs` given workspace root `R` to a
 * **workspace-relative** path. Fail closed: non-absolute input, control
 * characters, and any absolute path **not** under `R` (a different binding's
 * root, `/etc/…`, escapes) throw `WorkPathError`. Lexical only — the daemon
 * still enforces the real jail (symlink escapes are the daemon's job).
 */
export function workspaceAbsToRel(R: string, absPath: string): string {
  const root = normalizeWorkspaceRoot(R);
  if (typeof absPath !== 'string') {
    throw new WorkPathError('Path must be a string');
  }
  if (CONTROL_CHARS.test(absPath)) {
    throw new WorkPathError('Path contains control characters');
  }
  let abs = absPath.replace(/\\/g, '/').trim();
  if (!abs.startsWith('/')) {
    throw new WorkPathError('Host-absolute paths are not allowed');
  }
  abs = abs.replace(/\/+$/, '') || '/';

  if (abs === root) return '.';
  if (abs.startsWith(`${root}/`)) {
    // Rel path under R — normalize the tail (collapses . / .., blocks escapes).
    // Strip any extra leading slashes left by a join like `R + '/' + '/src'`
    // (still a legal in-jail POSIX path) so `<R>//src/foo.ts` shares the same
    // ledger key as `src/foo.ts`.
    return normalizeWorkspaceRel(abs.slice(root.length + 1).replace(/^\/+/, ''));
  }
  // Absolute path not under this binding's root — never map silently.
  throw new WorkPathError('Path escapes workspace root');
}

/** Maximum number of jail-root → workspace-relative rewrites per output stream. */
export const EXEC_ROOT_REWRITE_CAP = 4096;

/**
 * True for a character that may appear *inside* a `/`-rooted path token in
 * `exec` output. `.` is a path character (not a boundary) so interior dots in
 * real paths (`.git`, extensions, `.bin`) never split a token; only a
 * structural punctuation / whitespace / control character ends a token.
 */
function isPathChar(ch: string): boolean {
  if (ch === '/') return true;
  const code = ch.charCodeAt(0);
  if (code <= 0x20 || code === 0x7f) return false; // whitespace / control
  switch (ch) {
    case ',':
    case ':':
    case ';':
    case '(':
    case ')':
    case '[':
    case ']':
    case '{':
    case '}':
    case '"':
    case "'":
    case '`':
      return false;
    default:
      return true; // letters, digits, `.` `-` `_` `+` `~` `@` `=` …
  }
}

/**
 * Canonicalize every absolute path under the per-binding jail root `R` that
 * appears in `exec` stdout/stderr to its workspace-relative form, so the model
 * sees one base coordinate system (`exec pwd` ≡ `pwd`). Pure host-side; the
 * daemon is not touched.
 *
 * Fail-open: when `R` is `null` / `undefined` / `''` (BYO daemon down/pre-v2,
 * probe fault, option absent) the text is returned byte-for-byte unchanged, so
 * the tool result is identical to today. A malformed/`CONTROL_CHARS` `R` also
 * passes through — this helper never throws and never introduces control
 * characters. Out-of-jail absolute tokens (a different root, `/etc/…`, `C:\…`)
 * and `..` / escape tokens fail closed inside `workspaceAbsToRel` and stream
 * through unchanged. A `//` run is not a POSIX root and is left as-is; a `/`
 * whose preceding character is a path character is interior to another token
 * and is not treated as a root start. Rewrites are capped at
 * `EXEC_ROOT_REWRITE_CAP`; past the cap the remaining text is passed through.
 */
export function rewriteExecRootToRel(
  R: string | null | undefined,
  text: string,
): string {
  const src = text == null ? '' : String(text);
  if (typeof R !== 'string' || R === '') return src;
  let root: string;
  try {
    root = normalizeWorkspaceRoot(R);
  } catch {
    return src;
  }
  if (root === '/') return src; // filesystem root — rewriting is meaningless

  let out = '';
  let rewrites = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch !== '/' || rewrites >= EXEC_ROOT_REWRITE_CAP) {
      out += ch;
      i += 1;
      continue;
    }
    // Not a root start when part of `//` or when the preceding char is a path
    // character (the `/` is interior to a token already being passed through).
    if (src[i + 1] === '/' || (i > 0 && isPathChar(src[i - 1]))) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && isPathChar(src[j])) j += 1;
    const token = src.slice(i, j);
    try {
      out += workspaceAbsToRel(root, token);
      rewrites += 1;
    } catch {
      out += token; // out-of-jail / escape / malformed → pass through, never throw
    }
    i = j;
  }
  return out;
}

/**
 * Canonicalize a user path to a workspace-relative ledger key given workspace
 * root `R`. An absolute path **under** `R` maps to its workspace-relative form
 * (so `src/foo.ts` ≡ `<R>/src/foo.ts` hash to the same freshness key); a
 * relative path falls through `normalizeWorkspaceRel` unchanged; a host-absolute
 * path **outside** `R` (or an escape) is rejected — fail closed, per binding.
 */
export function canonicalizePath(R: string, userPath: string): string {
  const root = normalizeWorkspaceRoot(R);
  const p = userPath == null || userPath === '' ? '.' : String(userPath);
  let raw = p.replace(/\\/g, '/').trim();
  if (raw === '') raw = '.';
  if (raw.startsWith('/') || raw.startsWith('//') || /^[a-zA-Z]:/.test(raw)) {
    // Host-absolute: only the same binding's root maps; everything else rejects.
    return workspaceAbsToRel(root, raw);
  }
  return normalizeWorkspaceRel(raw);
}

/**
 * Prefix-aware resolve: join `path` under logical `cwd`, unless `path` is
 * already workspace-root-relative under/equal to cwd (model copied tool results)
 * OR is an **exact ancestor** of cwd (predictable re-root navigation — phase 3
 * of #464, `change_dir invincible` from `cwd=invincible/docs` → `invincible`,
 * not the phantom `invincible/docs/invincible`).
 *
 * Paths with leading `..` are joined under cwd first (so `change_dir ..` works)
 * and still error once past the workspace root (unchanged).
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
    (nAlone === c ||
      nAlone.startsWith(`${c}/`) ||
      // Exact-ancestor re-root: `nAlone` is a strict ancestor of `cwd`
      // (`cwd` starts with `nAlone + '/'`), mirroring the inverted prefix rule.
      c.startsWith(`${nAlone}/`))
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

/**
 * R-aware tool path resolver (single seam for FS tools + change_dir).
 * An absolute input **under** the per-binding jail root `R` canonicalizes to the
 * same workspace-relative freshness key as its relative form (in-jail absolute
 * ≡ relative); an absolute outside `R` / an escape fails closed ("Path escapes
 * workspace root"). When `R` is unavailable (`null` / `undefined` / `''` — BYO
 * daemon down/pre-v2, probe fault, or the option absent) any absolute is
 * rejected with a "root unavailable" message while relative + logical cwd
 * (#270) still resolve. Relative input is resolved against `cwd` unchanged.
 */
export function resolvePathForTool(
  R: string | null | undefined,
  cwd: string,
  userPath: string,
): string {
  const raw = String(userPath ?? '').replace(/\\/g, '/').trim();
  const effective = raw === '' ? '.' : raw;
  const isAbs =
    effective.startsWith('/') || effective.startsWith('//') ||
    /^[a-zA-Z]:/.test(effective);
  if (isAbs) {
    if (typeof R === 'string' && R !== '') {
      return canonicalizePath(R, effective);
    }
    throw new WorkPathError(
      'Sandbox workspace root unavailable — use a workspace-relative path',
    );
  }
  return resolveAgainstCwd(cwd, effective);
}

/**
 * R-aware executor: resolve the `exec` tool's `cwd` field. Empty/missing ->
 * current logical cwd (relative). Absolute -> `canonicalizePath` when `R` is
 * present (in-jail), else the same "root unavailable" error as path args for a
 * uniform message contract. Relative -> `resolveAgainstCwd` (unchanged #270).
 */
export function resolveExecCwdForTool(
  R: string | null | undefined,
  logicalCwd: string,
  execCwd?: string | null,
): string {
  const raw =
    execCwd == null ? '' : String(execCwd).replace(/\\/g, '/').trim();
  if (raw === '') {
    return normalizeWorkspaceRel(logicalCwd || '.');
  }
  const isAbs =
    raw.startsWith('/') || raw.startsWith('//') || /^[a-zA-Z]:/.test(raw);
  if (isAbs) {
    if (typeof R === 'string' && R !== '') {
      return canonicalizePath(R, raw);
    }
    throw new WorkPathError(
      'Sandbox workspace root unavailable — use a workspace-relative path',
    );
  }
  return resolveAgainstCwd(logicalCwd, raw);
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
