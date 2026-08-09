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
  resolveAgainstCwd,
  resolveExecCwd,
} from './workPath';

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
};

function finalize(text: string, secrets: Array<string | undefined | null>): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

function deny(toolName: string, need: 'read' | 'write', secrets: Array<string | undefined | null>) {
  return finalize(`ERROR ${toolName}: permission denied (need ${need})`, secrets);
}

function resolvePathOrError(
  cwdSnap: string,
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: resolveAgainstCwd(cwdSnap, path) };
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
 * AI SDK tools bound to a sandbox client. Soft-fail: never throw.
 * Paths resolve against turn logical cwd (prefix-aware); results are root-relative.
 */
export function createAgentTools(opts: CreateAgentToolsOptions) {
  const { client, signal } = opts;
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
      'Change the logical workspace directory for subsequent tools this turn (and session when the host persists cwd). Path is relative to the current logical cwd unless already workspace-root-relative under that cwd. Prefer as its own step before a burst of path tools. Does not run process.chdir on the sandbox daemon.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to current logical cwd, or already root-relative under it',
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
        const resolved = resolvePathOrError(cwdSnap, input.path);
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
      'List files and directories under the sandbox workspace. Paths are relative to the logical cwd (or workspace-root-relative when already rooted under cwd).',
    inputSchema: jsonSchema<{ path?: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to logical cwd (default ".")',
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
        const resolved = resolvePathOrError(cwdSnap, raw);
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
      'Read a text file from the sandbox workspace (max 16 MiB). Path is relative to logical cwd unless already workspace-root-relative under cwd.',
    inputSchema: jsonSchema<{ path: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to logical cwd or workspace-root-relative under cwd',
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
        const resolved = resolvePathOrError(cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR read_file: ${resolved.error}`, secrets);
        }
        const path = resolved.path;
        const result = await client.readFile(path, input.maxBytes, { signal });
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
      'Write a text file in the sandbox workspace (max 16 MiB). Path relative to logical cwd unless already rooted under cwd.',
    inputSchema: jsonSchema<{ path: string; content: string; mkdir?: boolean }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to logical cwd or workspace-root-relative under cwd',
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
        const resolved = resolvePathOrError(cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR write_file: ${resolved.error}`, secrets);
        }
        const path = resolved.path;
        const result = await client.writeFile(path, input.content, input.mkdir, {
          signal,
        });
        const ann = formatCwdAnnotation(cwdSnap);
        return finalize(
          `write_file ${path}${ann}: ok bytes=${result.bytes}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR write_file: ${msg}`, secrets);
      }
    },
  });

  const str_replace = tool({
    description:
      'Replace exact text in a sandbox file. old_string must match uniquely unless replace_all is true. Prefer this over write_file for small edits; use write_file to create or fully rewrite files. Path relative to logical cwd unless already rooted under cwd.',
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
          description: 'File path relative to logical cwd or workspace-root-relative under cwd',
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
        const resolved = resolvePathOrError(cwdSnap, input.path);
        if (!resolved.ok) {
          return finalize(`ERROR str_replace: ${resolved.error}`, secrets);
        }
        const path = resolved.path;
        const result = await client.strReplace(
          path,
          input.old_string,
          input.new_string,
          input.replace_all,
          { signal },
        );
        const ann = formatCwdAnnotation(cwdSnap);
        return finalize(
          `str_replace ${path}${ann}: ok replacements=${result.replacements} bytes=${result.bytes}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR str_replace: ${msg}`, secrets);
      }
    },
  });

  const exec = tool({
    description:
      'Run a command in the sandbox (argv only, no shell). Optional cwd is resolved against the logical workspace cwd (default = logical cwd). Optional stdin/heredoc feeds multi-line input on the process stdin without a shell. Default timeout 5 min, max 30 min.',
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
          description: 'Working directory under workspace (relative to logical cwd; default = logical cwd)',
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
          execCwd = resolveExecCwd(cwdSnap, input.cwd);
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
        const parts = [
          head,
          result.timedOut ? 'TIMED_OUT' : `exit=${result.exitCode}`,
        ];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
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
