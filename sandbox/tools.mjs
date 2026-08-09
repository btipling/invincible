import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_READ_WRITE_BYTES,
  MAX_STDIO_BYTES,
  MIN_EXEC_TIMEOUT_MS,
} from './constants.mjs';
import { JailError, resolveJailPath } from './paths.mjs';

export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}

/** Allowlisted keys for request-scoped exec env overlay (user GitHub PAT). */
export const ALLOWED_EXEC_ENV_KEYS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN']);

/**
 * Minimal env for child processes — never inherit SANDBOX_TOKEN or host secrets.
 * Optional allowlisted overlay (e.g. user GitHub PAT) is merged after base env.
 * @param {string} workspace
 * @param {Record<string, string>} [overlay]
 */
export function buildExecEnv(workspace, overlay) {
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: workspace,
    TMPDIR: path.join(workspace, '.tmp'),
    LANG: process.env.LANG || 'C.UTF-8',
  };
  if (process.env.TERM) env.TERM = process.env.TERM;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  if (overlay) {
    for (const key of ALLOWED_EXEC_ENV_KEYS) {
      const v = overlay[key];
      if (typeof v === 'string' && v.length > 0) {
        env[key] = v;
      }
    }
  }
  return env;
}

/**
 * Validate request body.env for /v1/exec. Returns allowlisted overlay or null.
 * @param {unknown} raw
 * @returns {Record<string, string> | null}
 */
export function parseExecEnvOverlay(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('env must be an object', 400);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (!ALLOWED_EXEC_ENV_KEYS.includes(key)) {
      throw new ToolError(`env key not allowed: ${key}`, 400);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new ToolError(`env.${key} must be a non-empty string`, 400);
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** @param {number} [timeoutMs] */
function clampTimeout(timeoutMs) {
  if (timeoutMs == null || Number.isNaN(Number(timeoutMs))) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  const n = Math.floor(Number(timeoutMs));
  if (n < MIN_EXEC_TIMEOUT_MS) return MIN_EXEC_TIMEOUT_MS;
  if (n > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return n;
}

/** @param {number} [maxBytes] */
function clampMaxBytes(maxBytes) {
  if (maxBytes == null || Number.isNaN(Number(maxBytes))) {
    return MAX_READ_WRITE_BYTES;
  }
  const n = Math.floor(Number(maxBytes));
  if (n < 0) return 0;
  if (n > MAX_READ_WRITE_BYTES) return MAX_READ_WRITE_BYTES;
  return n;
}

/** @param {{ isFile(): boolean, isDirectory(): boolean }} dirent */
function entryType(dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  return 'other';
}

/**
 * On-disk fingerprint for read-before-edit gate 2 (additive protocol fields).
 * @param {{ mtimeMs: number, size: number }} stat
 * @returns {{ mtimeMs: number, size: number }}
 */
function fingerprintFromStat(stat) {
  const mtimeRaw = stat.mtimeMs;
  const out = { size: stat.size };
  if (typeof mtimeRaw === 'number' && Number.isFinite(mtimeRaw)) {
    out.mtimeMs = Math.trunc(mtimeRaw);
  }
  return out;
}

/**
 * @param {string} workspace
 * @param {{ path?: string }} body
 */
export async function listDir(workspace, body) {
  const target = resolveJailPath(workspace, body?.path ?? '.');
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new ToolError('Directory not found', 404);
  }
  if (!stat.isDirectory()) {
    throw new ToolError('Not a directory', 400);
  }
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries = dirents
    .map((d) => ({ name: d.name, type: entryType(d) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { entries };
}

/**
 * @param {string} workspace
 * @param {{ path?: string, maxBytes?: number }} body
 * @returns {Promise<{ content: string, truncated?: boolean, mtimeMs: number, size: number }>}
 */
export async function readFileTool(workspace, body) {
  if (body?.path == null || body.path === '') {
    throw new ToolError('path is required');
  }
  const target = resolveJailPath(workspace, body.path);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new ToolError('File not found', 404);
  }
  if (!stat.isFile()) {
    throw new ToolError('Not a file', 400);
  }
  const max = clampMaxBytes(body.maxBytes);
  const fh = await fs.open(target, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    const truncated = bytesRead > max;
    const content = buf.subarray(0, Math.min(bytesRead, max)).toString('utf8');
    const fp = fingerprintFromStat(stat);
    return truncated
      ? { content, truncated: true, ...fp }
      : { content, ...fp };
  } finally {
    await fh.close();
  }
}

/**
 * @param {string} workspace
 * @param {{ path?: string, content?: string, mkdir?: boolean }} body
 * @returns {Promise<{ ok: true, bytes: number, mtimeMs: number, size: number }>}
 */
export async function writeFileTool(workspace, body) {
  if (body?.path == null || body.path === '') {
    throw new ToolError('path is required');
  }
  if (typeof body.content !== 'string') {
    throw new ToolError('content must be a string');
  }
  const contentBuf = Buffer.from(body.content, 'utf8');
  if (contentBuf.byteLength > MAX_READ_WRITE_BYTES) {
    throw new ToolError(
      `content exceeds maxBytes limit (${MAX_READ_WRITE_BYTES})`,
      413,
    );
  }
  const target = resolveJailPath(workspace, body.path);
  const parent = path.dirname(target);

  if (body.mkdir) {
    await fs.mkdir(parent, { recursive: true });
  } else {
    try {
      await fs.stat(parent);
    } catch {
      throw new ToolError('Parent directory does not exist (set mkdir: true)', 400);
    }
  }

  await fs.writeFile(target, contentBuf);
  const st = await fs.stat(target);
  return {
    ok: true,
    bytes: contentBuf.byteLength,
    ...fingerprintFromStat(st),
  };
}

/**
 * Exact string replace in a workspace file (coding-agent search_replace semantics).
 * @param {string} workspace
 * @param {{ path?: string, old_string?: string, new_string?: string, replace_all?: boolean }} body
 * @returns {Promise<{ ok: true, path: string, replacements: number, bytes: number, mtimeMs: number, size: number }>}
 */
export async function strReplaceTool(workspace, body) {
  if (body?.path == null || body.path === '') {
    throw new ToolError('path is required');
  }
  if (typeof body.old_string !== 'string' || body.old_string.length === 0) {
    throw new ToolError('old_string is required and must be non-empty');
  }
  if (typeof body.new_string !== 'string') {
    throw new ToolError('new_string must be a string');
  }
  if (body.old_string === body.new_string) {
    throw new ToolError('old_string and new_string are identical');
  }

  const replaceAll = Boolean(body.replace_all);
  const target = resolveJailPath(workspace, body.path);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new ToolError('File not found', 404);
  }
  if (!stat.isFile()) {
    throw new ToolError('Not a file', 400);
  }
  if (stat.size > MAX_READ_WRITE_BYTES) {
    throw new ToolError(
      `content exceeds maxBytes limit (${MAX_READ_WRITE_BYTES})`,
      413,
    );
  }

  const content = await fs.readFile(target, 'utf8');
  const oldStr = body.old_string;
  const newStr = body.new_string;

  // Non-overlapping left-to-right count
  let count = 0;
  let from = 0;
  while (from <= content.length) {
    const idx = content.indexOf(oldStr, from);
    if (idx === -1) break;
    count += 1;
    from = idx + oldStr.length;
    if (oldStr.length === 0) break; // defensive; empty already rejected
  }

  if (count === 0) {
    throw new ToolError('old_string not found in file', 400);
  }
  if (count > 1 && !replaceAll) {
    throw new ToolError(
      `old_string matched ${count} times; pass replace_all: true or provide a unique snippet`,
      409,
    );
  }

  const next = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);

  const outBuf = Buffer.from(next, 'utf8');
  if (outBuf.byteLength > MAX_READ_WRITE_BYTES) {
    throw new ToolError(
      `content exceeds maxBytes limit (${MAX_READ_WRITE_BYTES})`,
      413,
    );
  }

  await fs.writeFile(target, outBuf);
  const stAfter = await fs.stat(target);
  return {
    ok: true,
    path: String(body.path),
    replacements: replaceAll ? count : 1,
    bytes: outBuf.byteLength,
    ...fingerprintFromStat(stAfter),
  };
}

/**
 * Cheap path metadata for create-vs-update and freshness re-check (no content).
 * @param {string} workspace
 * @param {{ path?: string }} body
 * @returns {Promise<{ path: string, type: 'file' | 'dir' | 'other', mtimeMs: number, size: number }>}
 */
export async function statTool(workspace, body) {
  if (body?.path == null || body.path === '') {
    throw new ToolError('path is required');
  }
  const target = resolveJailPath(workspace, body.path);
  let st;
  try {
    st = await fs.stat(target);
  } catch {
    throw new ToolError('Path not found', 404);
  }
  /** @type {'file' | 'dir' | 'other'} */
  let type = 'other';
  if (st.isFile()) type = 'file';
  else if (st.isDirectory()) type = 'dir';
  return {
    path: String(body.path),
    type,
    ...fingerprintFromStat(st),
  };
}

/**
 * @param {import('node:stream').Readable | null | undefined} stream
 * @param {number} max
 */
function attachCappedCollector(stream, max) {
  /** @type {Buffer[]} */
  const chunks = [];
  let len = 0;
  let truncated = false;
  stream?.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (len >= max) {
      truncated = true;
      return;
    }
    const room = max - len;
    if (buf.byteLength > room) {
      chunks.push(buf.subarray(0, room));
      len += room;
      truncated = true;
    } else {
      chunks.push(buf);
      len += buf.byteLength;
    }
  });
  return {
    getBuffer: () => Buffer.concat(chunks),
    wasTruncated: () => truncated,
  };
}

/**
 * Resolve optional stdin / heredoc body for exec.
 * Accepts `stdin` (preferred) or `heredoc` alias. Still argv-only — no shell.
 * @param {{ stdin?: unknown, heredoc?: unknown }} body
 * @returns {Buffer | null} null = leave stdin closed (ignore); Buffer may be empty
 */
export function resolveExecStdin(body) {
  const raw =
    body?.stdin !== undefined && body?.stdin !== null
      ? body.stdin
      : body?.heredoc !== undefined && body?.heredoc !== null
        ? body.heredoc
        : undefined;
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new ToolError('stdin must be a string (heredoc body)');
  }
  const buf = Buffer.from(raw, 'utf8');
  if (buf.byteLength > MAX_STDIO_BYTES) {
    throw new ToolError(
      `stdin exceeds maxBytes limit (${MAX_STDIO_BYTES})`,
      413,
    );
  }
  return buf;
}

/**
 * @param {string} workspace
 * @param {{ cmd?: string, args?: string[], cwd?: string, timeoutMs?: number, stdin?: string, heredoc?: string, env?: Record<string, string> }} body
 */
export async function execCmd(workspace, body) {
  if (body?.cmd == null || typeof body.cmd !== 'string' || body.cmd === '') {
    throw new ToolError('cmd is required');
  }
  if (body.args != null && !Array.isArray(body.args)) {
    throw new ToolError('args must be an array of strings');
  }
  const args = (body.args ?? []).map((a) => {
    if (typeof a !== 'string') throw new ToolError('args must be an array of strings');
    return a;
  });

  const stdinBuf = resolveExecStdin(body ?? {});

  const cwd = resolveJailPath(workspace, body.cwd ?? '.');
  let cwdStat;
  try {
    cwdStat = await fs.stat(cwd);
  } catch {
    throw new ToolError('cwd not found', 404);
  }
  if (!cwdStat.isDirectory()) {
    throw new ToolError('cwd is not a directory', 400);
  }

  const timeoutMs = clampTimeout(body.timeoutMs);
  const useDetached = process.platform !== 'win32';
  const pipeStdin = stdinBuf != null;
  const overlay = parseExecEnvOverlay(body.env);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(body.cmd, args, {
        cwd,
        shell: false,
        env: buildExecEnv(path.resolve(workspace), overlay ?? undefined),
        detached: useDetached,
        stdio: [pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new ToolError(
          err instanceof Error ? err.message : 'Failed to spawn process',
          500,
        ),
      );
      return;
    }

    const stdoutCol = attachCappedCollector(child.stdout, MAX_STDIO_BYTES);
    const stderrCol = attachCappedCollector(child.stderr, MAX_STDIO_BYTES);

    const killTree = () => {
      if (!child.pid) return;
      try {
        if (useDetached) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    if (pipeStdin && child.stdin) {
      child.stdin.on('error', (err) => {
        // EPIPE if child exits before consuming all stdin — not a hard failure.
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'EPIPE') {
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree();
        reject(new ToolError(err.message || 'stdin write failed', 500));
      });
      child.stdin.end(stdinBuf);
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        stdout: stdoutCol.getBuffer().toString('utf8'),
        stderr: stderrCol.getBuffer().toString('utf8'),
        ...(timedOut ? { timedOut: true } : {}),
        ...(stdoutCol.wasTruncated() ? { stdoutTruncated: true } : {}),
        ...(stderrCol.wasTruncated() ? { stderrTruncated: true } : {}),
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError(err.message, 500));
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}

export { JailError };
