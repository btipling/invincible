/**
 * Vercel Sandbox–backed SandboxClient — attach-only durable Workspace instance.
 * Product path: Sandbox.get({ name, resume: true }) + extendTimeout; close never stops.
 * Never create or get-or-create; never stop or delete here (lifecycle = userSandboxInstance).
 */

import path from 'node:path';
import { normalizeWorkspaceRel, WorkPathError } from '../agent/workPath';
import { commandOutput } from '../agent/vercelSandboxHttpRunner';
import {
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  resolveVercelSandboxImage,
} from '../tenancy/sandboxBackend';
import { clampExecTimeoutMs } from './config';
import type { SandboxClient } from './client';
import {
  SandboxHttpError,
  type ExecResult,
  type ListDirResult,
  type ReadFileResult,
  type StrReplaceResult,
  type WriteFileResult,
} from './types';

/** Logical absolute jail root inside the Vercel microVM. */
export const VERCEL_FS_WORKSPACE_ROOT = '/vercel/workspace';

/** Match agent route maxDuration / hop-B sandbox lifetime family (30m). */
export const DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS = 1_800_000;
export const MAX_VERCEL_FS_SANDBOX_TIMEOUT_MS = 1_800_000;
export const MIN_VERCEL_FS_SANDBOX_TIMEOUT_MS = 5_000;

/** Same hard cap as BYO daemon read/write. */
export const VERCEL_FS_MAX_READ_WRITE_BYTES = 16 * 1024 * 1024;

/** Soft cap for exec stdout/stderr collection. */
const MAX_STDIO_BYTES = 4 * 1024 * 1024;

export type VercelFsSandboxCommandResult = {
  exitCode: number | null;
  stdout?: string | ((opts?: { signal?: AbortSignal }) => Promise<string>);
  stderr?: string | ((opts?: { signal?: AbortSignal }) => Promise<string>);
  output?: (
    stream?: 'stdout' | 'stderr' | 'both',
    opts?: { signal?: AbortSignal },
  ) => Promise<string>;
};

export type VercelFsDirentLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

export type VercelFsSandboxLike = {
  fs: {
    readdir(
      dirPath: string,
      options?: {
        signal?: AbortSignal;
        withFileTypes?: boolean;
      },
    ): Promise<string[] | VercelFsDirentLike[]>;
    readFile(
      filePath: string,
      options?:
        | { encoding?: BufferEncoding | null; signal?: AbortSignal }
        | BufferEncoding
        | null,
    ): Promise<string | Buffer>;
    writeFile(
      filePath: string,
      data: string | Buffer,
      options?: { signal?: AbortSignal } | BufferEncoding,
    ): Promise<void>;
    mkdir(
      dirPath: string,
      options?: { recursive?: boolean; signal?: AbortSignal },
    ): Promise<unknown>;
    stat?(
      filePath: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
  };
  /**
   * Mirrors @vercel/sandbox: string form only forwards signal/timeoutMs;
   * cwd/env require the object form (RunCommandParams).
   */
  runCommand(
    commandOrParams:
      | string
      | {
          cmd: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          signal?: AbortSignal;
          timeoutMs?: number;
        },
    args?: string[],
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<VercelFsSandboxCommandResult>;
  /** Present on real SDK; attach client never calls stop. */
  stop?(opts?: { signal?: AbortSignal }): Promise<unknown>;
  extendTimeout?(
    durationMs: number,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export type GetVercelFsSandboxParams = {
  name: string;
  resume?: boolean;
  signal?: AbortSignal;
};

export type GetVercelFsSandboxFn = (
  params: GetVercelFsSandboxParams,
) => Promise<VercelFsSandboxLike>;

export type CreateVercelSandboxClientOptions = {
  /** Durable instance name (`user_sandbox_instances.vercel_name`). Required. */
  name: string;
  /**
   * Frozen image from instance row (optional; used for preflight shape only).
   * Attach does not create an image.
   */
  image?: string | null;
  /** Inject Sandbox.get (tests). Default: @vercel/sandbox Sandbox.get. */
  getSandbox?: GetVercelFsSandboxFn;
  /** Idle extendTimeout ms (default 30m — USER_SANDBOX_IDLE family). */
  idleTimeoutMs?: number;
  /** Absolute jail root inside the VM. Default `/vercel/workspace`. */
  workspaceRoot?: string;
  /**
   * Server-owned allowlisted env merged into every `runCommand` (exec only).
   * Only GH_TOKEN / GITHUB_TOKEN should be supplied. Never from the model.
   */
  execEnv?: Record<string, string>;
};

function clampSandboxTimeout(ms: number | undefined): number {
  const n =
    ms == null || !Number.isFinite(ms)
      ? DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS
      : Math.floor(ms);
  if (n < MIN_VERCEL_FS_SANDBOX_TIMEOUT_MS) return MIN_VERCEL_FS_SANDBOX_TIMEOUT_MS;
  if (n > MAX_VERCEL_FS_SANDBOX_TIMEOUT_MS) return MAX_VERCEL_FS_SANDBOX_TIMEOUT_MS;
  return n;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Map SDK/path failures to tool-visible errors without secrets. */
function mapFsError(err: unknown, fallbackStatus = 502): never {
  if (err instanceof SandboxHttpError) throw err;
  if (err instanceof WorkPathError) {
    throw new SandboxHttpError(err.message, 400);
  }
  if (isAbortError(err)) {
    throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
  }
  const message = err instanceof Error ? err.message : 'Sandbox request failed';
  // Strip common secret-looking substrings (tokens often appear in SDK auth errors).
  const safe = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/VERCEL_TOKEN[=:]\S+/gi, 'VERCEL_TOKEN=[redacted]')
    .replace(/oidc[^\s]*/gi, 'oidc[redacted]');
  const lower = safe.toLowerCase();
  let status = fallbackStatus;
  if (lower.includes('not found') || lower.includes('enoent')) status = 404;
  else if (
    lower.includes('not ready') ||
    lower.includes('unoptimized') ||
    lower.includes('unknown image') ||
    lower.includes('invalid image') ||
    lower.includes('image not found') ||
    lower.includes('image is not')
  ) {
    status = 400;
  } else if (
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication') ||
    lower.includes('not authenticated')
  ) {
    status = 403;
  }
  throw new SandboxHttpError(safe || 'Sandbox request failed', status);
}

async function defaultGetSandbox(
  params: GetVercelFsSandboxParams,
): Promise<VercelFsSandboxLike> {
  const { Sandbox } = await import('@vercel/sandbox');
  const sb = await Sandbox.get({
    name: params.name,
    resume: params.resume ?? true,
    signal: params.signal,
  });
  return sb as unknown as VercelFsSandboxLike;
}

/**
 * Resolve workspace-relative tool path to an absolute path under the jail root.
 */
export function resolveVercelFsPath(workspaceRoot: string, userPath: string): string {
  const root = workspaceRoot.replace(/\/+$/, '') || VERCEL_FS_WORKSPACE_ROOT;
  if (!root.startsWith('/')) {
    throw new WorkPathError('Workspace root must be an absolute path');
  }
  let rel: string;
  try {
    rel = normalizeWorkspaceRel(userPath ?? '.');
  } catch (err) {
    if (err instanceof WorkPathError) throw err;
    throw new WorkPathError(err instanceof Error ? err.message : 'Invalid path');
  }
  if (rel === '.') return root;
  const abs = path.posix.join(root, rel);
  // Defense in depth: joined path must stay under root
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new WorkPathError('Path escapes workspace root');
  }
  return abs;
}

function entryType(d: VercelFsDirentLike): 'file' | 'dir' | 'other' {
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  return 'other';
}

function clampMaxBytes(maxBytes?: number): number {
  if (maxBytes == null || Number.isNaN(Number(maxBytes))) {
    return VERCEL_FS_MAX_READ_WRITE_BYTES;
  }
  const n = Math.floor(Number(maxBytes));
  if (n < 0) return 0;
  if (n > VERCEL_FS_MAX_READ_WRITE_BYTES) return VERCEL_FS_MAX_READ_WRITE_BYTES;
  return n;
}

function capStdio(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_STDIO_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_STDIO_BYTES), truncated: true };
}

function normalizeExecEnv(
  raw: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const v = raw[key];
    if (typeof v === 'string' && v.length > 0) {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createVercelSandboxClient(
  opts: CreateVercelSandboxClientOptions,
): SandboxClient {
  const name = opts.name?.trim();
  if (!name) {
    throw new SandboxHttpError('Sandbox instance name is required', 400);
  }
  // Optional image preflight (instance row may carry frozen image); never used to create.
  if (opts.image !== undefined && opts.image !== null) {
    const resolved = resolveVercelSandboxImage(opts.image);
    if (!resolved.ok) {
      throw new SandboxHttpError(resolved.error, 400);
    }
  }

  const getSandbox = opts.getSandbox ?? defaultGetSandbox;
  const idleTimeoutMs = clampSandboxTimeout(opts.idleTimeoutMs);
  const workspaceRoot = (opts.workspaceRoot?.trim() || VERCEL_FS_WORKSPACE_ROOT).replace(
    /\/+$/,
    '',
  );
  const execEnv = normalizeExecEnv(opts.execEnv);

  let attachPromise: Promise<VercelFsSandboxLike> | null = null;
  let sandbox: VercelFsSandboxLike | null = null;
  let closed = false;
  let rootReady = false;

  async function bestEffortExtend(sb: VercelFsSandboxLike): Promise<void> {
    if (typeof sb.extendTimeout !== 'function') return;
    try {
      await sb.extendTimeout(idleTimeoutMs);
    } catch {
      // best-effort — never fail the turn
    }
  }

  async function ensureSandbox(signal?: AbortSignal): Promise<VercelFsSandboxLike> {
    if (closed) {
      throw new SandboxHttpError('Sandbox client is closed', 400);
    }
    if (sandbox && rootReady) return sandbox;
    if (!attachPromise) {
      attachPromise = getSandbox({
        name,
        resume: true,
        signal,
      })
        .then(async (sb) => {
          sandbox = sb;
          if (closed) {
            throw new SandboxHttpError('Sandbox client is closed', 400);
          }
          await bestEffortExtend(sb);
          try {
            await sb.fs.mkdir(workspaceRoot, { recursive: true, signal });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/exist/i.test(msg) && !/EEXIST/i.test(msg)) {
              // Do not stop durable VM — clear latch for retry only.
              sandbox = null;
              rootReady = false;
              attachPromise = null;
              mapFsError(err, 502);
            }
          }
          rootReady = true;
          if (closed) {
            throw new SandboxHttpError('Sandbox client is closed', 400);
          }
          return sb;
        })
        .catch((err) => {
          if (!sandbox) {
            attachPromise = null;
            rootReady = false;
          }
          mapFsError(err, 502);
        });
    }
    return attachPromise;
  }

  async function releaseHandle(): Promise<void> {
    const sb = sandbox;
    sandbox = null;
    rootReady = false;
    if (!sb) return;
    // Keep warm — never stop/delete attach clients.
    await bestEffortExtend(sb);
  }

  async function close(): Promise<void> {
    if (closed) {
      await releaseHandle();
      return;
    }
    closed = true;
    const pending = attachPromise;
    attachPromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        // attach failed mid-flight — handle may still be set
      }
    }
    await releaseHandle();
  }

  const client: SandboxClient = {
    async listDir(userPath = '.', init): Promise<ListDirResult> {
      try {
        const abs = resolveVercelFsPath(workspaceRoot, userPath);
        const sb = await ensureSandbox(init?.signal);
        if (typeof sb.fs.stat === 'function') {
          let st;
          try {
            st = await sb.fs.stat(abs, { signal: init?.signal });
          } catch (err) {
            mapFsError(err, 404);
          }
          if (!st.isDirectory()) {
            throw new SandboxHttpError('Not a directory', 400);
          }
        }
        const raw = await sb.fs.readdir(abs, {
          withFileTypes: true,
          signal: init?.signal,
        });
        const entries = (raw as Array<string | VercelFsDirentLike>)
          .map((d) => {
            if (typeof d === 'string') {
              return { name: d, type: 'other' as const };
            }
            return { name: d.name, type: entryType(d) };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        return { entries };
      } catch (err) {
        mapFsError(err);
      }
    },

    async readFile(userPath, maxBytes, init): Promise<ReadFileResult> {
      try {
        if (userPath == null || userPath === '') {
          throw new SandboxHttpError('path is required', 400);
        }
        const abs = resolveVercelFsPath(workspaceRoot, userPath);
        const sb = await ensureSandbox(init?.signal);
        const max = clampMaxBytes(maxBytes);

        // Prefer stat when available (real @vercel/sandbox): type-check + size gate
        // so we never pull multi-GB files into the host process for a truncated read.
        if (typeof sb.fs.stat === 'function') {
          let st;
          try {
            st = await sb.fs.stat(abs, { signal: init?.signal });
          } catch (err) {
            mapFsError(err, 404);
          }
          if (!st.isFile()) {
            throw new SandboxHttpError('Not a file', 400);
          }
          if (st.size > max) {
            // Byte-capped read via head (matches BYO daemon open+read max+1 pattern).
            // String form: only signal/timeoutMs (path is absolute; cwd unused).
            const cmd = await sb.runCommand('head', ['-c', String(max + 1), abs], {
              signal: init?.signal,
              timeoutMs: 120_000,
            });
            const { stdout } = await commandOutput(cmd);
            const buf = Buffer.from(stdout, 'utf8');
            const slice = buf.byteLength > max ? buf.subarray(0, max) : buf;
            return {
              content: slice.toString('utf8'),
              truncated: true,
            };
          }
        }

        const content = await sb.fs.readFile(abs, {
          encoding: 'utf8',
          signal: init?.signal,
        });
        const text = typeof content === 'string' ? content : content.toString('utf8');
        const buf = Buffer.from(text, 'utf8');
        if (buf.byteLength > max) {
          return { content: buf.subarray(0, max).toString('utf8'), truncated: true };
        }
        return { content: text };
      } catch (err) {
        mapFsError(err);
      }
    },

    async writeFile(userPath, content, mkdir, init): Promise<WriteFileResult> {
      try {
        if (userPath == null || userPath === '') {
          throw new SandboxHttpError('path is required', 400);
        }
        if (typeof content !== 'string') {
          throw new SandboxHttpError('content must be a string', 400);
        }
        const buf = Buffer.from(content, 'utf8');
        if (buf.byteLength > VERCEL_FS_MAX_READ_WRITE_BYTES) {
          throw new SandboxHttpError(
            `content exceeds maxBytes limit (${VERCEL_FS_MAX_READ_WRITE_BYTES})`,
            413,
          );
        }
        const abs = resolveVercelFsPath(workspaceRoot, userPath);
        const sb = await ensureSandbox(init?.signal);
        if (mkdir) {
          const parent = path.posix.dirname(abs);
          if (parent !== abs) {
            await sb.fs.mkdir(parent, { recursive: true, signal: init?.signal });
          }
        }
        await sb.fs.writeFile(abs, content, { signal: init?.signal });
        return { ok: true, bytes: buf.byteLength };
      } catch (err) {
        mapFsError(err);
      }
    },

    async strReplace(
      userPath,
      oldString,
      newString,
      replaceAll,
      init,
    ): Promise<StrReplaceResult> {
      try {
        if (userPath == null || userPath === '') {
          throw new SandboxHttpError('path is required', 400);
        }
        if (typeof oldString !== 'string' || oldString.length === 0) {
          throw new SandboxHttpError('old_string is required and must be non-empty', 400);
        }
        if (typeof newString !== 'string') {
          throw new SandboxHttpError('new_string must be a string', 400);
        }
        if (oldString === newString) {
          throw new SandboxHttpError('old_string and new_string are identical', 400);
        }

        const abs = resolveVercelFsPath(workspaceRoot, userPath);
        const sb = await ensureSandbox(init?.signal);
        const raw = await sb.fs.readFile(abs, {
          encoding: 'utf8',
          signal: init?.signal,
        });
        const content = typeof raw === 'string' ? raw : raw.toString('utf8');
        if (Buffer.byteLength(content, 'utf8') > VERCEL_FS_MAX_READ_WRITE_BYTES) {
          throw new SandboxHttpError(
            `content exceeds maxBytes limit (${VERCEL_FS_MAX_READ_WRITE_BYTES})`,
            413,
          );
        }

        let count = 0;
        let from = 0;
        while (from <= content.length) {
          const idx = content.indexOf(oldString, from);
          if (idx === -1) break;
          count += 1;
          from = idx + oldString.length;
        }
        if (count === 0) {
          throw new SandboxHttpError('old_string not found in file', 400);
        }
        if (count > 1 && !replaceAll) {
          throw new SandboxHttpError(
            `old_string matched ${count} times; pass replace_all: true or provide a unique snippet`,
            409,
          );
        }

        const next = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);
        const outBuf = Buffer.from(next, 'utf8');
        if (outBuf.byteLength > VERCEL_FS_MAX_READ_WRITE_BYTES) {
          throw new SandboxHttpError(
            `content exceeds maxBytes limit (${VERCEL_FS_MAX_READ_WRITE_BYTES})`,
            413,
          );
        }
        await sb.fs.writeFile(abs, next, { signal: init?.signal });
        return {
          ok: true,
          path: userPath,
          replacements: replaceAll ? count : 1,
          bytes: outBuf.byteLength,
        };
      } catch (err) {
        mapFsError(err);
      }
    },

    async exec(body, init): Promise<ExecResult> {
      try {
        if (body?.cmd == null || typeof body.cmd !== 'string' || body.cmd === '') {
          throw new SandboxHttpError('cmd is required', 400);
        }
        if (body.args != null && !Array.isArray(body.args)) {
          throw new SandboxHttpError('args must be an array of strings', 400);
        }
        const args = (body.args ?? []).map((a) => {
          if (typeof a !== 'string') {
            throw new SandboxHttpError('args must be an array of strings', 400);
          }
          return a;
        });
        // @vercel/sandbox RunCommandParams has no stdin — fail soft so the agent
        // never sees a false stdin=NB success (use write_file + argv path instead).
        const stdinRaw =
          body?.stdin !== undefined && body?.stdin !== null
            ? body.stdin
            : body?.heredoc !== undefined && body?.heredoc !== null
              ? body.heredoc
              : undefined;
        if (stdinRaw !== undefined) {
          if (typeof stdinRaw !== 'string') {
            throw new SandboxHttpError('stdin must be a string (heredoc body)', 400);
          }
          throw new SandboxHttpError(
            'exec stdin/heredoc is not supported on the Vercel sandbox backend ' +
              '(SDK has no stdin). Write input to a file (write_file) and pass its path via args, ' +
              'or use a BYO daemon (protocol v2+).',
            400,
          );
        }
        const cwdAbs = resolveVercelFsPath(workspaceRoot, body.cwd ?? '.');
        const timeoutMs = clampExecTimeoutMs(body.timeoutMs);
        const sb = await ensureSandbox(init?.signal);
        // Object form required: @vercel/sandbox 3-arg string form drops cwd/env.
        const cmd = await sb.runCommand({
          cmd: body.cmd,
          args,
          cwd: cwdAbs,
          signal: init?.signal,
          timeoutMs,
          // Only server-owned allowlisted execEnv (user GitHub PAT). Never host secrets.
          ...(execEnv ? { env: execEnv } : {}),
        });
        const { stdout, stderr } = await commandOutput(cmd);
        const out = capStdio(stdout);
        const err = capStdio(stderr);
        return {
          exitCode: cmd.exitCode,
          stdout: out.text,
          stderr: err.text,
          ...(out.truncated ? { stdoutTruncated: true } : {}),
          ...(err.truncated ? { stderrTruncated: true } : {}),
        };
      } catch (err) {
        mapFsError(err);
      }
    },

    close,
  };

  return client;
}

/** Re-export default image for tests/docs. */
export { DEFAULT_VERCEL_SANDBOX_IMAGE };
