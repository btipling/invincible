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
    description: 'Read a text file from the sandbox workspace (max 256 KiB).',
    inputSchema: jsonSchema<{ path: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        maxBytes: {
          type: 'number',
          description: 'Optional max bytes to read (server-capped at 256 KiB)',
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
    description: 'Write a text file in the sandbox workspace (max 256 KiB).',
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

  const exec = tool({
    description:
      'Run a command in the sandbox (argv only, no shell). cwd is path-jailed. Default timeout 10s, max 30s.',
    inputSchema: jsonSchema<{
      cmd: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
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
        timeoutMs: { type: 'number', description: 'Timeout in ms (1–30000)' },
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
        const result = await client.exec(
          {
            cmd: input.cmd,
            args: input.args,
            cwd: input.cwd,
            timeoutMs,
          },
          { signal },
        );
        const parts = [
          `exec ${input.cmd}`,
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

  return { list_dir, read_file, write_file, exec };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
