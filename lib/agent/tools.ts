import { jsonSchema, tool } from 'ai';
import {
  TOOL_RESULT_MAX_CHARS,
  clampExecTimeoutMs,
} from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { redactSecrets, truncateForModel } from './redact';

export type ToolPermissions = {
  canRead: boolean;
  canWrite: boolean;
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
};

function finalize(text: string, secrets: Array<string | undefined | null>): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

function deny(toolName: string, need: 'read' | 'write', secrets: Array<string | undefined | null>) {
  return finalize(`ERROR ${toolName}: permission denied (need ${need})`, secrets);
}

/**
 * AI SDK tools bound to a sandbox client. Soft-fail: never throw.
 */
export function createAgentTools(opts: CreateAgentToolsOptions) {
  const { client, signal } = opts;
  const secrets = opts.secrets ?? [];
  const permissions: ToolPermissions = opts.permissions ?? {
    canRead: true,
    canWrite: true,
  };

  const list_dir = tool({
    description:
      'List files and directories under the sandbox workspace. Paths are relative to the workspace root.',
    inputSchema: jsonSchema<{ path?: string }>({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace root (default ".")',
        },
      },
      additionalProperties: false,
    }),
    execute: async (input) => {
      if (!permissions.canRead) {
        return deny('list_dir', 'read', secrets);
      }
      try {
        const path = input?.path?.trim() || '.';
        const result = await client.listDir(path, { signal });
        const names = result.entries.map((e) => `${e.name}(${e.type})`).join(', ');
        return finalize(
          `list_dir ${path}: ${result.entries.length} entries${names ? ` — ${names}` : ''}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR list_dir: ${msg}`, secrets);
      }
    },
  });

  const read_file = tool({
    description: 'Read a text file from the sandbox workspace (max 16 MiB).',
    inputSchema: jsonSchema<{ path: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
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
        const path = input.path;
        if (!path) return finalize('ERROR read_file: path is required', secrets);
        const result = await client.readFile(path, input.maxBytes, { signal });
        const flag = result.truncated ? ' (truncated)' : '';
        return finalize(`read_file ${path}${flag}:\n${result.content}`, secrets);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR read_file: ${msg}`, secrets);
      }
    },
  });

  const write_file = tool({
    description: 'Write a text file in the sandbox workspace (max 16 MiB).',
    inputSchema: jsonSchema<{ path: string; content: string; mkdir?: boolean }>({
      type: 'object',
      properties: {
        path: { type: 'string' },
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
        const result = await client.writeFile(
          input.path,
          input.content,
          input.mkdir,
          { signal },
        );
        return finalize(
          `write_file ${input.path}: ok bytes=${result.bytes}`,
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
      'Replace exact text in a sandbox file. old_string must match uniquely unless replace_all is true. Prefer this over write_file for small edits; use write_file to create or fully rewrite files.',
    inputSchema: jsonSchema<{
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
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
        const result = await client.strReplace(
          input.path,
          input.old_string,
          input.new_string,
          input.replace_all,
          { signal },
        );
        return finalize(
          `str_replace ${input.path}: ok replacements=${result.replacements} bytes=${result.bytes}`,
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
      'Run a command in the sandbox (argv only, no shell). Optional stdin/heredoc feeds multi-line input on the process stdin without a shell. cwd is path-jailed. Default timeout 5 min, max 30 min.',
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
        cwd: { type: 'string', description: 'Working directory under workspace' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 5 min, max 30 min)' },
        stdin: {
          type: 'string',
          description:
            'Optional UTF-8 body written to the process stdin (heredoc-style; no shell). Prefer this over shell <<EOF.',
        },
        heredoc: {
          type: 'string',
          description: 'Alias for stdin — multi-line input fed to the process without a shell',
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
            cwd: input.cwd,
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

  return { list_dir, read_file, write_file, str_replace, exec };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
