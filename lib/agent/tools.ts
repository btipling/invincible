import { jsonSchema, tool } from 'ai';
import {
  SEARCH_LINE_MAX_BYTES,
  SEARCH_MAX_FILESIZE_STR,
  SEARCH_MAX_RESULTS,
  SEARCH_PER_FILE_MAX_COUNT,
  SEARCH_RESULT_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  TOOL_RESULT_MAX_CHARS,
  clampExecTimeoutMs,
  MIN_SANDBOX_PROTOCOL_STDIN,
} from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { redactSecrets, truncateForModel } from './redact';
import {
  WorkPathError,
  formatCwdAnnotation,
  normalizeWorkspaceRel,
  resolveExecCwdForTool,
  resolvePathForTool,
  rewriteExecRootToRel,
} from './workPath';
import {
  editGateError,
  type DiskFingerprint,
  type RunFileFreshness,
} from './fileFreshness';
import { defaultPathLock, lockKey } from './pathLock';
import {
  envUnavailableReason,
  formatSandboxInfoEnv,
  SANDBOX_INFO_ENV_EXEC_TIMEOUT_MS,
  type SandboxInfoBind,
} from './sandboxInfo';
import { EXPECTED_SANDBOX_DAEMON_VERSION } from '../sandbox/daemonVersion';

export type ToolPermissions = {
  canRead: boolean;
  canWrite: boolean;
};

/** Mutable logical cwd for one agent turn (shared; tools snapshot at execute start). */
export type CwdState = {
  current: string;
};

export type CreateAgentToolsOptions = {
  client: SandboxClient;
  /**
   * Run-scoped read-before-edit ledger. Required — create once in runAgent /
   * runAgentStream and pass the same object into every createAgentTools call
   * in that HTTP turn (including future in-process sub-agents).
   */
  freshness: RunFileFreshness;
  /** Secrets to redact from tool results (token, etc.). */
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  /**
   * Grant-derived permissions. Default full access (env / legacy inject path).
   * Write does not need to re-encode write⇒read here — caller should pass effective flags.
   */
  permissions?: ToolPermissions;
  /**
   * Turn-scoped logical cwd. When omitted, starts at `"."`.
   * Mutated only by successful `change_dir`.
   */
  cwdState?: CwdState;
  /** Initial cwd when cwdState not provided (normalized). */
  initialCwd?: string;
  /**
   * Per-binding jail workspace root R (turn-scoped). When present, host-absolute
   * paths under R are canonicalized to the same workspace-relative key as their
   * relative form on all FS tools + change_dir + exec cwd; out-of-jail absolutes
   * fail closed. When null/undefined/'', absolute paths are rejected ("root
   * unavailable") while relative + cwd still resolve. Plain relative paths are
   * unaffected in all cases.
   */
  workspaceRoot?: string | null;
  /**
   * Optional active-bind projection for `sandbox_info`. Omitted in unit tests
   * that only exercise other tools — the info tool still returns cwd /
   * permissions / env.
   */
  bind?: SandboxInfoBind;
};

/** Per-side cap for the expandable str_replace old→new audit block (plan #665). */
export const STR_REPLACE_DIFF_SIDE_MAX_BYTES = 4096;

const STR_REPLACE_DIFF_TRUNC_SUFFIX = '… (truncated)';

function clipUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** Default line window for read_file (Grok Build; plan #689). NEW cap. */
export const READ_FILE_DEFAULT_LIMIT = 1000;

export type LineWindow = {
  body: string;
  returned: number;
  totalLines: number;
};

/**
 * Numbered line window over backend content. `offset` is 1-based.
 * `totalLines` is lines in `content` (`split('\\n')`), not a disk recount.
 */
export function formatLineWindow(
  content: string,
  offset: number,
  limit: number,
): LineWindow {
  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const start = Math.max(0, offset - 1);
  const selected =
    start >= allLines.length ? [] : allLines.slice(start, start + limit);
  const body = selected
    .map((line, i) => `${start + i + 1}→${line}`)
    .join('\n');
  return { body, returned: selected.length, totalLines };
}

/** Full-file edit grant: offset 1, not byte-truncated, window reached content EOF. */
export function isFullFileReadGrant(opts: {
  offset: number;
  returned: number;
  totalLines: number;
  byteTruncated: boolean;
}): boolean {
  if (opts.offset !== 1 || opts.byteTruncated) return false;
  return opts.offset - 1 + opts.returned >= opts.totalLines;
}

function parsePositiveInt(n: unknown, fallback: number): number {
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) {
    return Math.floor(n);
  }
  return fallback;
}

/** Redact then cap one side of the str_replace audit diff. */
export function formatStrReplaceDiffSide(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  const redacted = redactSecrets(text ?? '', secrets);
  if (Buffer.byteLength(redacted, 'utf8') <= STR_REPLACE_DIFF_SIDE_MAX_BYTES) {
    return redacted;
  }
  return `${clipUtf8Bytes(redacted, STR_REPLACE_DIFF_SIDE_MAX_BYTES)}${STR_REPLACE_DIFF_TRUNC_SUFFIX}`;
}

/** Sentinel lines used as structural headers in the audit block. */
const AUDIT_OLD_MARKER = '-old_string';
const AUDIT_NEW_MARKER = '+new_string';

/** Keep content from colliding with the structural `-old_string` / `+new_string` headers. */
function escapeAuditContent(s: string): string {
  return s
    .split('\n')
    .map((line) =>
      line === AUDIT_OLD_MARKER || line === AUDIT_NEW_MARKER ? ` ${line}` : line,
    )
    .join('\n');
}

function appendStrReplaceDiff(
  statusLine: string,
  oldString: string,
  newString: string,
  secrets: Array<string | undefined | null>,
): string {
  const oldSide = escapeAuditContent(formatStrReplaceDiffSide(oldString, secrets));
  const newSide = escapeAuditContent(formatStrReplaceDiffSide(newString, secrets));
  return `${statusLine}\n${AUDIT_OLD_MARKER}\n${oldSide}\n${AUDIT_NEW_MARKER}\n${newSide}`;
}

function strReplaceError(path: string | undefined, rest: string): string {
  return path ? `ERROR str_replace ${path}: ${rest}` : `ERROR str_replace: ${rest}`;
}

function finalize(text: string, secrets: Array<string | undefined | null>): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

function deny(toolName: string, need: 'read' | 'write', secrets: Array<string | undefined | null>) {
  return finalize(`ERROR ${toolName}: permission denied (need ${need})`, secrets);
}

function resolvePathOrError(
  workspaceRoot: string | null | undefined,
  cwdSnap: string,
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: resolvePathForTool(workspaceRoot, cwdSnap, path) };
  } catch (err) {
    const msg =
      err instanceof WorkPathError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * True only when the sandbox reports the **path** is missing (create-new
 * write_file). Must not treat protocol/route 404s (e.g. stale BYO daemon
 * missing `POST /v1/stat` → `{ error: "Not found" }`) as path absence — that
 * would skip read-before-edit and overwrite existing files.
 *
 * Accept: BYO `Path not found` / `File not found` / `Directory not found`,
 * Node/Vercel `ENOENT` / "no such file or directory".
 * Reject: bare `Not found`, `Sandbox request failed (404)`, any non-path 404.
 */
export function isPathMissingError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).trim();
  if (/\bENOENT\b/i.test(msg)) return true;
  if (/no such file or directory/i.test(msg)) return true;
  // Exact BYO tool strings (stat/read/list)
  if (/^(Path|File|Directory) not found$/i.test(msg)) return true;
  return false;
}

function finiteFp(partial: DiskFingerprint): DiskFingerprint {
  const out: DiskFingerprint = {};
  if (typeof partial.mtimeMs === 'number' && Number.isFinite(partial.mtimeMs)) {
    out.mtimeMs = partial.mtimeMs;
  }
  if (typeof partial.size === 'number' && Number.isFinite(partial.size)) {
    out.size = partial.size;
  }
  return out;
}

/**
 * Prefer fingerprint fields on the tool result; fill via client.stat when incomplete
 * so Production Vercel (often no mtime on read/write) still powers gate 2.
 */
async function resolveFingerprint(
  client: SandboxClient,
  path: string,
  partial: DiskFingerprint,
  signal?: AbortSignal,
): Promise<DiskFingerprint> {
  const base = finiteFp(partial);
  if (
    typeof base.mtimeMs === 'number' &&
    Number.isFinite(base.mtimeMs) &&
    typeof base.size === 'number' &&
    Number.isFinite(base.size)
  ) {
    return base;
  }
  try {
    const st = await client.stat(path, { signal });
    const filled = finiteFp({
      mtimeMs: base.mtimeMs ?? st.mtimeMs,
      size: base.size ?? st.size,
    });
    return filled;
  } catch {
    return base;
  }
}

/**
 * AI SDK tools bound to a sandbox client. Soft-fail: never throw.
 * Paths resolve against turn logical cwd (prefix-aware); results are root-relative.
 */
export function createAgentTools(opts: CreateAgentToolsOptions) {
  const { client, signal, freshness } = opts;
  const workspaceRoot = opts.workspaceRoot;
  const bind = opts.bind;
  const secrets = opts.secrets ?? [];
  const permissions: ToolPermissions = opts.permissions ?? {
    canRead: true,
    canWrite: true,
  };

  let initial = '.';
  try {
    initial = normalizeWorkspaceRel(opts.initialCwd ?? opts.cwdState?.current ?? '.');
  } catch {
    initial = '.';
  }
  const cwdState: CwdState = opts.cwdState ?? { current: initial };
  if (!opts.cwdState) {
    cwdState.current = initial;
  } else {
    try {
      cwdState.current = normalizeWorkspaceRel(cwdState.current || '.');
    } catch {
      cwdState.current = '.';
    }
  }

  const pwd = tool({
    description:
      'Print the current logical workspace directory (workspace-root-relative). Use after change_dir or to confirm where relative paths resolve.',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      if (!permissions.canRead) {
        return deny('pwd', 'read', secrets);
      }
      const cwdSnap = cwdState.current;
      return finalize(`pwd: ${cwdSnap}`, secrets);
    },
  });

  const change_dir = tool({
    description:
      'Change the logical workspace directory for subsequent tools this turn (and session when the host persists cwd). Path is relative to the current logical cwd unless already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Prefer as its own step before a burst of path tools. Does not run process.chdir on the sandbox daemon. Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to current logical cwd, already root-relative under it, or an in-jail absolute path under the sandbox root. Must be within the workspace — never /tmp or host temp dirs.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canRead) {
        return deny('change_dir', 'read', secrets);
      }
      try {
        if (!input?.path) {
          return finalize('ERROR change_dir: path is required', secrets);
        }
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR change_dir: ${resolved.error}`, secrets);
        }
        // Verify directory via listDir (daemon rejects non-dirs).
        await client.listDir(resolved.path, { signal });
        cwdState.current = resolved.path;
        return finalize(
          `change_dir ${resolved.path}: ok cwd=${resolved.path}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR change_dir: ${msg}`, secrets);
      }
    },
  });

  const list_dir = tool({
    description:
      'List files and directories under the sandbox workspace. Paths are relative to the logical cwd (or workspace-root-relative when already rooted under cwd), or an in-jail absolute path under the sandbox root (same file as the relative form). Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{ path?: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to logical cwd (default "."), or an in-jail absolute path under the sandbox root. Must be within the workspace — never /tmp or host temp dirs.',
        },
      },
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canRead) {
        return deny('list_dir', 'read', secrets);
      }
      try {
        const cwdSnap = cwdState.current;
        const raw = input?.path?.trim() || '.';
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, raw);
        if (!resolved.ok) {
          return finalize(`ERROR list_dir: ${resolved.error}`, secrets);
        }
        const path = resolved.path;
        const result = await client.listDir(path, { signal });
        const names = result.entries.map((e) => `${e.name}(${e.type})`).join(', ');
        const ann = formatCwdAnnotation(cwdSnap);
        return finalize(
          `list_dir ${path}${ann}: ${result.entries.length} entries${names ? ` — ${names}` : ''}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR list_dir: ${msg}`, secrets);
      }
    },
  });

  const read_file = tool({
    description:
      'Read a text file from the sandbox workspace (max 16 MiB). Optional offset (1-based start line, default 1) and limit (max lines, default 1000) return a line-numbered window (N→content). A successful full read — offset 1 covering every line of the returned content, not clipped by limit or maxBytes — authorizes later str_replace / overwrite of that path in this agent run until the on-disk file changes. Path is relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{
      path: string;
      maxBytes?: number;
      offset?: number;
      limit?: number;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Must be within the workspace — never /tmp or host temp dirs.',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read (server-capped at 16 MiB)',
        },
        offset: {
          type: 'number',
          description: '1-based start line (default 1)',
        },
        limit: {
          type: 'number',
          description: 'Max lines to return (default 1000)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canRead) {
        return deny('read_file', 'read', secrets);
      }
      try {
        if (!input.path) return finalize('ERROR read_file: path is required', secrets);
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR read_file: ${resolved.error}`, secrets);
        }
        const path = resolved.path;
        const offset = parsePositiveInt(input.offset, 1);
        const limit = parsePositiveInt(input.limit, READ_FILE_DEFAULT_LIMIT);
        const result = await client.readFile(path, input.maxBytes, { signal });
        const window = formatLineWindow(result.content, offset, limit);
        const byteTruncated = result.truncated === true;
        const fullGrant = isFullFileReadGrant({
          offset,
          returned: window.returned,
          totalLines: window.totalLines,
          byteTruncated,
        });
        if (fullGrant) {
          const fp = await resolveFingerprint(
            client,
            path,
            { mtimeMs: result.mtimeMs, size: result.size },
            signal,
          );
          freshness.recordRead(path, { ...fp, truncated: false });
        } else {
          freshness.recordRead(path, { truncated: true });
        }
        const flag = fullGrant ? '' : ' (truncated)';
        const ann = formatCwdAnnotation(cwdSnap);
        return finalize(
          `read_file ${path} offset=${offset} limit=${limit} lines=${window.returned}/${window.totalLines}${flag}${ann}:\n${window.body}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR read_file: ${msg}`, secrets);
      }
    },
  });

  const write_file = tool({
    description:
      'Write a text file in the sandbox workspace (max 16 MiB). Creating a new path does not require a prior read. Overwriting an existing file requires a successful full read_file of that path earlier in this agent run (re-read if the file changed on disk). Path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{ path: string; content: string; mkdir?: boolean }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Must be within the workspace — never /tmp or host temp dirs.',
        },
        content: { type: 'string' },
        mkdir: {
          type: 'boolean',
          description: 'Create parent directories if missing',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canWrite) {
        return deny('write_file', 'write', secrets);
      }
      try {
        if (!input.path) return finalize('ERROR write_file: path is required', secrets);
        if (typeof input.content !== 'string') {
          return finalize('ERROR write_file: content must be a string', secrets);
        }
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR write_file: ${resolved.error}`, secrets);
        }
        const path = resolved.path;

        // Per-path serialize + re-validate on latest bytes (bug #479): the whole
        // stat → gate → write → recordWrite critical section runs under the path
        // lock so overlapping same-path applies never interleave a stale snapshot.
        // Key is namespaced by the per-binding jail root so the process-global
        // lock does not head-of-line block unrelated sandboxes (review L7 #481).
        return await defaultPathLock.withPathLock(
          lockKey(workspaceRoot, path),
          async () => {
            let exists = true;
            let live: DiskFingerprint = {};
            try {
              const st = await client.stat(path, { signal });
              live = finiteFp({ mtimeMs: st.mtimeMs, size: st.size });
            } catch (err) {
              if (isPathMissingError(err)) {
                exists = false;
              } else {
                const msg = err instanceof Error ? err.message : String(err);
                return finalize(`ERROR write_file: ${msg}`, secrets);
              }
            }

            if (exists) {
              const gate = freshness.assertCanEdit(path, live);
              if (!gate.ok) {
                return finalize(editGateError('write_file', gate.code), secrets);
              }
            }

            const result = await client.writeFile(
              path,
              input.content,
              input.mkdir,
              { signal },
            );
            const fp = await resolveFingerprint(
              client,
              path,
              { mtimeMs: result.mtimeMs, size: result.size },
              signal,
            );
            freshness.recordWrite(path, fp);
            const ann = formatCwdAnnotation(cwdSnap);
            return finalize(
              `write_file ${path}${ann}: ok bytes=${result.bytes}`,
              secrets,
            );
          },
          signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR write_file: ${msg}`, secrets);
      }
    },
  });

  const str_replace = tool({
    description:
      'Exact string replace in a workspace file (coding-agent search_replace). Requires a successful full read_file of the path earlier in this agent run; re-read if the file changed on disk (other session, device, tool, or exec). old_string must match uniquely unless replace_all is true. Prefer this over write_file for small edits; use write_file to create or fully rewrite files. Path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Must be within the workspace — never /tmp or host temp dirs.',
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find (must be unique unless replace_all)',
        },
        new_string: { type: 'string', description: 'Replacement text (may be empty to delete)' },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace every non-overlapping match',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canWrite) {
        return finalize(strReplaceError(input.path, 'permission denied (need write)'), secrets);
      }
      try {
        if (!input.path) return finalize('ERROR str_replace: path is required', secrets);
        if (typeof input.old_string !== 'string' || input.old_string.length === 0) {
          return finalize(
            strReplaceError(input.path, 'old_string is required and must be non-empty'),
            secrets,
          );
        }
        if (typeof input.new_string !== 'string') {
          return finalize(strReplaceError(input.path, 'new_string must be a string'), secrets);
        }
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(strReplaceError(input.path, resolved.error), secrets);
        }
        const path = resolved.path;

        // Per-path serialize + re-validate on latest bytes (bug #479): the whole
        // stat → gate → replace → recordWrite critical section runs under the
        // path lock so two overlapping same-path applies never both pass the
        // gate on a shared snapshot and silently drop one edit. Key is
        // namespaced by the per-binding jail root (review L7 #481).
        return await defaultPathLock.withPathLock(
          lockKey(workspaceRoot, path),
          async () => {
            let live: DiskFingerprint = {};
            try {
              const st = await client.stat(path, { signal });
              live = finiteFp({ mtimeMs: st.mtimeMs, size: st.size });
            } catch (err) {
              if (isPathMissingError(err)) {
                return finalize(strReplaceError(path, 'File not found'), secrets);
              }
              const msg = err instanceof Error ? err.message : String(err);
              return finalize(strReplaceError(path, msg), secrets);
            }

            const gate = freshness.assertCanEdit(path, live);
            if (!gate.ok) {
              const errMsg = editGateError('str_replace', gate.code);
              // editGateError returns "ERROR str_replace: …rest" — inject the resolved path.
              return finalize(
                errMsg.replace('ERROR str_replace:', `ERROR str_replace ${path}:`),
                secrets,
              );
            }

            const result = await client.strReplace(
              path,
              input.old_string,
              input.new_string,
              input.replace_all,
              { signal },
            );
            const fp = await resolveFingerprint(
              client,
              path,
              { mtimeMs: result.mtimeMs, size: result.size },
              signal,
            );
            freshness.recordWrite(path, fp);
            const ann = formatCwdAnnotation(cwdSnap);
            return finalize(
              appendStrReplaceDiff(
                `str_replace ${path}${ann}: ok replacements=${result.replacements} bytes=${result.bytes}`,
                input.old_string,
                input.new_string,
                secrets,
              ),
              secrets,
            );
          },
          signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(strReplaceError(input.path, msg), secrets);
      }
    },
  });

  const exec = tool({
    description:
      'Run a command in the sandbox (argv only, no shell). Optional cwd is resolved against the logical workspace cwd (default = logical cwd). Optional stdin/heredoc feeds multi-line input on the process stdin without a shell. Default timeout 5 min, max 30 min. Absolute workspace paths in stdout/stderr are printed workspace-relative. Never use /tmp or other host temp dirs — they are outside the workspace and will fail or vanish.',
    inputSchema: jsonSchema<{
      cmd: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      stdin?: string;
      heredoc?: string;
    }>({
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Executable name or path' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument vector',
        },
        cwd: {
          type: 'string',
          description: 'Working directory under workspace (relative to logical cwd; default = logical cwd). In-jail absolute paths under the sandbox root are accepted. Must be within the workspace — never /tmp or host temp dirs.',
        },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 5 min, max 30 min)' },
        stdin: {
          type: 'string',
          description:
            'Optional UTF-8 body written to the process stdin (no shell). Prefer stdin over heredoc. Prefer this over shell <<EOF. Unsupported on Vercel backend.',
        },
        heredoc: {
          type: 'string',
          description:
            'Alias for stdin (use stdin when possible). Multi-line input without a shell; unsupported on Vercel backend',
        },
      },
      required: ['cmd'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canWrite) {
        return deny('exec', 'write', secrets);
      }
      try {
        if (!input.cmd) return finalize('ERROR exec: cmd is required', secrets);
        // argv-only (no shell): a shell-style single-string command (whitespace
        // in `cmd` and no explicit `args`) almost always means the caller forgot
        // to split into argv. Fail loudly with guidance instead of a bare
        // ENOENT/"cannot execute" from the daemon. A single executable name has
        // no whitespace, so `true`/`ls` etc. are unaffected.
        if (!input.args?.length && /\s/.test(input.cmd)) {
          return finalize(
            'ERROR exec: cmd is a shell string but exec runs argv only (no shell). ' +
              'Pass args as an array, or use cmd for a single executable.',
            secrets,
          );
        }
        const cwdSnap = cwdState.current;
        let execCwd: string;
        try {
          execCwd = resolveExecCwdForTool(workspaceRoot, cwdSnap, input.cwd);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return finalize(`ERROR exec: ${msg}`, secrets);
        }
        const timeoutMs = clampExecTimeoutMs(input.timeoutMs);
        const stdin =
          typeof input.stdin === 'string'
            ? input.stdin
            : typeof input.heredoc === 'string'
              ? input.heredoc
              : undefined;
        const result = await client.exec(
          {
            cmd: input.cmd,
            args: input.args,
            cwd: execCwd,
            timeoutMs,
            ...(stdin !== undefined ? { stdin } : {}),
          },
          { signal },
        );
        const head =
          stdin !== undefined
            ? `exec ${input.cmd} stdin=${Buffer.byteLength(stdin, 'utf8')}B`
            : `exec ${input.cmd}`;
        const stdout = rewriteExecRootToRel(workspaceRoot, result.stdout);
        const stderr = rewriteExecRootToRel(workspaceRoot, result.stderr);
        const parts = [
          head,
          result.timedOut ? 'TIMED_OUT' : `exit=${result.exitCode}`,
        ];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        if (result.stdoutTruncated) parts.push('(stdout truncated)');
        if (result.stderrTruncated) parts.push('(stderr truncated)');
        return finalize(parts.join('\n'), secrets);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR exec: ${msg}`, secrets);
      }
    },
  });

  const search = tool({
    description:
      'Search (code-grep) the sandbox workspace with rg (ripgrep). Returns a bounded list of {path, line, text} hits with line numbers. Read-grant-only; argv is hard-built (never model-supplied cmd). Use this instead of exec rg/grep for "where is X?" questions. Pattern is a regex or fixed string (rg default). Optional globs are passed as -g <glob> (gitignore-aware full-path patterns). Path resolves against logical cwd (default "."). Caps: max_results server-capped to SEARCH_MAX_RESULTS, per-file max-count, max-filesize, per-line byte clip, and total result bytes. No matches returns "0 hits" (success, not error).',
    inputSchema: jsonSchema<{
      pattern: string;
      glob?: string[];
      path?: string;
      max_results?: number;
    }>({
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Required; regex or fixed string (rg default).',
        },
        glob: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional; each passed as -g <glob> (gitignore-aware full-path patterns).',
        },
        path: {
          type: 'string',
          description: 'Optional; resolvePathForTool, default cwd "."',
        },
        max_results: {
          type: 'number',
          description: 'Optional; server-capped to SEARCH_MAX_RESULTS.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canRead) {
        return deny('search', 'read', secrets);
      }
      try {
        if (!input.pattern) {
          return finalize('ERROR search: pattern is required', secrets);
        }
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path ?? '.');
        if (!resolved.ok) {
          return finalize(`ERROR search: ${resolved.error}`, secrets);
        }
        const searchPath = resolved.path;

        // Build fixed argv (never a model-supplied cmd)
        const args: string[] = [
          '-n',
          '--no-heading',
          '--max-count',
          String(SEARCH_PER_FILE_MAX_COUNT),
          '--max-filesize',
          SEARCH_MAX_FILESIZE_STR,
          '-S', // smart-case
        ];
        const globs: string[] = Array.isArray(input.glob)
          ? input.glob.filter((g): g is string => typeof g === 'string' && g.length > 0)
          : [];
        for (const g of globs) {
          args.push('-g', g);
        }
        args.push('-e', input.pattern, '--', searchPath);

        const result = await client.exec(
          {
            cmd: 'rg',
            args,
            cwd: '.',
            timeoutMs: SEARCH_TIMEOUT_MS,
          },
          { signal },
        );

        // rg exit 1 = no matches (success, not error)
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          const stderr = rewriteExecRootToRel(workspaceRoot, result.stderr);
          const hint =
            stderr && /command not found|No such file/i.test(stderr)
              ? 'rg not available in this sandbox — add it to the toolchain image or use exec'
              : stderr || `exit=${result.exitCode}`;
          return finalize(`ERROR search: ${hint}`, secrets);
        }

        const raw = rewriteExecRootToRel(workspaceRoot, result.stdout);
        if (result.exitCode === 1 || !raw.trim()) {
          return finalize(`search ${searchPath}${formatCwdAnnotation(cwdSnap)}: 0 hits`, secrets);
        }

        // Parse rg output: each line is "path:line:text"
        const lines = raw.split('\n');
        const cap = Math.min(
          input.max_results != null && Number.isFinite(input.max_results)
            ? Math.max(1, Math.floor(Number(input.max_results)))
            : SEARCH_MAX_RESULTS,
          SEARCH_MAX_RESULTS,
        );

        const hits: string[] = [];
        let byteTotal = 0;
        let skipped = 0;
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;

          // Split into path:line:text (at most first two colons to preserve text content)
          const firstColon = trimmed.indexOf(':');
          const afterFirst = firstColon >= 0 ? trimmed.slice(firstColon + 1) : '';
          const secondColon = afterFirst.indexOf(':');
          const filePath = firstColon >= 0 ? trimmed.slice(0, firstColon) : trimmed;
          const lineNum = secondColon >= 0 ? afterFirst.slice(0, secondColon) : '';
          const text = secondColon >= 0 ? afterFirst.slice(secondColon + 1) : '';

          // Per-line byte clip
          let clippedText = text;
          const textBytes = Buffer.byteLength(text, 'utf8');
          if (textBytes > SEARCH_LINE_MAX_BYTES) {
            clippedText = `${clipUtf8Bytes(text, SEARCH_LINE_MAX_BYTES)}…`;
          }

          const hit = `${filePath}:${lineNum}:${clippedText}`;
          const hitBytes = Buffer.byteLength(hit, 'utf8');

          if (hits.length >= cap || byteTotal + hitBytes > SEARCH_RESULT_MAX_BYTES) {
            skipped += 1;
            continue;
          }

          hits.push(hit);
          byteTotal += hitBytes;
        }

        const label = hits.length === 1 ? 'hit' : 'hits';
        const header = `search ${searchPath}${formatCwdAnnotation(cwdSnap)}: ${hits.length} ${label}`;
        const body = hits.join('\n');
        const truncated = skipped > 0 ? `\n(truncated, ${skipped} more)` : '';
        return finalize(`${header}\n${body}${truncated}`, secrets);
      } catch (err) {
        // rg missing / non-zero crash → soft-fail with guidance
        const msg = err instanceof Error ? err.message : String(err);
        if (/command not found|ENOENT|No such file/i.test(msg)) {
          return finalize(
            'ERROR search: rg not available in this sandbox — add it to the toolchain image or use exec',
            secrets,
          );
        }
        return finalize(`ERROR search: ${msg}`, secrets);
      }
    },
  });

  const sandbox_info = tool({
    description:
      'Structured facts about the active sandbox bind: backend, name/slug, logical cwd, grant permissions, capabilities (path tools, exec, stdin, stat), daemon protocol/version when a BYO daemon is bound, and a redacted env map. PATH-like values are per-entry arrays (workspace-relative under the jail). Use this instead of exec env, printenv, or uname. Needs read permission. No arguments.',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      if (!permissions.canRead) {
        return deny('sandbox_info', 'read', secrets);
      }
      try {
        const lines: string[] = ['sandbox_info:'];
        if (bind?.backend) lines.push(`backend=${bind.backend}`);
        if (bind?.sandboxId) lines.push(`id=${bind.sandboxId}`);
        if (bind?.name) lines.push(`name=${bind.name}`);
        if (bind?.slug) lines.push(`slug=${bind.slug}`);
        if (bind?.status) lines.push(`status=${bind.status}`);
        if (bind?.image) lines.push(`image=${bind.image}`);
        lines.push(`cwd=${cwdState.current}`);
        lines.push(`permissions.read=${permissions.canRead ? 'true' : 'false'}`);
        lines.push(`permissions.write=${permissions.canWrite ? 'true' : 'false'}`);

        let stdin = false;
        if (bind?.backend === 'vercel') {
          lines.push('daemon=none');
        } else if (typeof client.daemonInfo === 'function') {
          const d = await client.daemonInfo({ signal });
          if (!d) {
            lines.push('daemon: unavailable');
          } else {
            lines.push(`daemon.protocol=${d.version}`);
            lines.push(`daemon.version=${d.daemonVersion}`);
            lines.push(
              `daemon.out_of_date=${d.daemonVersion < EXPECTED_SANDBOX_DAEMON_VERSION ? 'true' : 'false'}`,
            );
            stdin = d.version >= MIN_SANDBOX_PROTOCOL_STDIN;
          }
        } else {
          lines.push('daemon=none');
        }

        const pathTools: string[] = [];
        if (permissions.canRead) pathTools.push('list_dir', 'read_file', 'search');
        if (permissions.canWrite) pathTools.push('write_file', 'str_replace', 'exec');
        pathTools.push('change_dir', 'pwd');
        if (permissions.canRead) pathTools.push('sandbox_info');

        lines.push(`capabilities.exec=${permissions.canWrite ? 'true' : 'false'}`);
        lines.push(`capabilities.stdin=${stdin ? 'true' : 'false'}`);
        lines.push('capabilities.stat=true');
        lines.push(`capabilities.path_tools=${pathTools.join(',')}`);

        try {
          const result = await client.exec(
            { cmd: 'env', timeoutMs: SANDBOX_INFO_ENV_EXEC_TIMEOUT_MS },
            { signal },
          );
          if (result.timedOut || result.exitCode !== 0) {
            lines.push(
              envUnavailableReason({
                timedOut: result.timedOut,
                exitCode: result.exitCode,
              }),
            );
          } else {
            const env = formatSandboxInfoEnv(
              result.stdout ?? '',
              workspaceRoot,
              secrets,
            );
            lines.push(...env.lines);
            if (env.omittedByCap > 0) {
              lines.push(`env.omitted=${env.omittedByCap}`);
            }
          }
        } catch (err) {
          const throwStatus =
            err && typeof err === 'object' && 'status' in err
              && typeof (err as { status: unknown }).status === 'number'
              ? (err as { status: number }).status
              : undefined;
          const throwName = err instanceof Error ? err.name : undefined;
          lines.push(
            envUnavailableReason({ threw: true, throwStatus, throwName }),
          );
        }

        return finalize(lines.join('\n'), secrets);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR sandbox_info: ${msg}`, secrets);
      }
    },
  });

  return { pwd, change_dir, list_dir, read_file, write_file, str_replace, exec, search, sandbox_info };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
