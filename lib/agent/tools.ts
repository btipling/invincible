import { jsonSchema, tool } from 'ai';
import {
  TOOL_RESULT_MAX_CHARS,
  clampExecTimeoutMs,
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
import { defaultPathLock } from './pathLock';

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
};

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
      'Change the logical workspace directory for subsequent tools this turn (and session when the host persists cwd). Path is relative to the current logical cwd unless already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form). Prefer as its own step before a burst of path tools. Does not run process.chdir on the sandbox daemon.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to current logical cwd, already root-relative under it, or an in-jail absolute path under the sandbox root',
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
      'List files and directories under the sandbox workspace. Paths are relative to the logical cwd (or workspace-root-relative when already rooted under cwd), or an in-jail absolute path under the sandbox root (same file as the relative form).',
    inputSchema: jsonSchema<{ path?: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to logical cwd (default "."), or an in-jail absolute path under the sandbox root',
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
      'Read a text file from the sandbox workspace (max 16 MiB). A successful full (non-truncated) read authorizes later str_replace / overwrite of that path in this agent run until the on-disk file changes. Path is relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form).',
    inputSchema: jsonSchema<{ path: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form)',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read (server-capped at 16 MiB)',
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
        const result = await client.readFile(path, input.maxBytes, { signal });
        if (result.truncated) {
          freshness.recordRead(path, { truncated: true });
        } else {
          const fp = await resolveFingerprint(
            client,
            path,
            { mtimeMs: result.mtimeMs, size: result.size },
            signal,
          );
          freshness.recordRead(path, { ...fp, truncated: false });
        }
        const flag = result.truncated ? ' (truncated)' : '';
        const ann = formatCwdAnnotation(cwdSnap);
        return finalize(
          `read_file ${path}${flag}${ann}:\n${result.content}`,
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
      'Write a text file in the sandbox workspace (max 16 MiB). Creating a new path does not require a prior read. Overwriting an existing file requires a successful full read_file of that path earlier in this agent run (re-read if the file changed on disk). Path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form).',
    inputSchema: jsonSchema<{ path: string; content: string; mkdir?: boolean }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form)',
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
        return await defaultPathLock.withPathLock(
          path,
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
      'Exact string replace in a workspace file (coding-agent search_replace). Requires a successful full read_file of the path earlier in this agent run; re-read if the file changed on disk (other session, device, tool, or exec). old_string must match uniquely unless replace_all is true. Prefer this over write_file for small edits; use write_file to create or fully rewrite files. Path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form).',
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
            'File path relative to logical cwd, already workspace-root-relative under it, or an in-jail absolute path under the sandbox root (same file as the relative form)',
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
        return deny('str_replace', 'write', secrets);
      }
      try {
        if (!input.path) return finalize('ERROR str_replace: path is required', secrets);
        if (typeof input.old_string !== 'string' || input.old_string.length === 0) {
          return finalize(
            'ERROR str_replace: old_string is required and must be non-empty',
            secrets,
          );
        }
        if (typeof input.new_string !== 'string') {
          return finalize('ERROR str_replace: new_string must be a string', secrets);
        }
        const cwdSnap = cwdState.current;
        const resolved = resolvePathOrError(workspaceRoot, cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR str_replace: ${resolved.error}`, secrets);
        }
        const path = resolved.path;

        // Per-path serialize + re-validate on latest bytes (bug #479): the whole
        // stat → gate → replace → recordWrite critical section runs under the
        // path lock so two overlapping same-path applies never both pass the
        // gate on a shared snapshot and silently drop one edit.
        return await defaultPathLock.withPathLock(
          path,
          async () => {
            let live: DiskFingerprint = {};
            try {
              const st = await client.stat(path, { signal });
              live = finiteFp({ mtimeMs: st.mtimeMs, size: st.size });
            } catch (err) {
              if (isPathMissingError(err)) {
                return finalize('ERROR str_replace: File not found', secrets);
              }
              const msg = err instanceof Error ? err.message : String(err);
              return finalize(`ERROR str_replace: ${msg}`, secrets);
            }

            const gate = freshness.assertCanEdit(path, live);
            if (!gate.ok) {
              return finalize(editGateError('str_replace', gate.code), secrets);
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
              `str_replace ${path}${ann}: ok replacements=${result.replacements} bytes=${result.bytes}`,
              secrets,
            );
          },
          signal,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR str_replace: ${msg}`, secrets);
      }
    },
  });

  const exec = tool({
    description:
      'Run a command in the sandbox (argv only, no shell). Optional cwd is resolved against the logical workspace cwd (default = logical cwd). Optional stdin/heredoc feeds multi-line input on the process stdin without a shell. Default timeout 5 min, max 30 min. Absolute workspace paths in stdout/stderr are printed workspace-relative.',
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
          description: 'Working directory under workspace (relative to logical cwd; default = logical cwd). In-jail absolute paths under the sandbox root are accepted.',
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

  return { pwd, change_dir, list_dir, read_file, write_file, str_replace, exec };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
