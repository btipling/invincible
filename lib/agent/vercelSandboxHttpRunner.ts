/**
 * Vercel Sandbox-backed HttpFetchRunner (hop B egress).
 * Single-flight create; persistent:false; stop on close.
 */

import type {
  HttpFetchGetInput,
  HttpFetchGetResult,
  HttpFetchRunner,
} from './httpFetchTypes';
import {
  MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
  DEFAULT_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
} from './builtinHttpConfig';

export const BUILTIN_HTTP_USER_AGENT = 'InvincibleBuiltinHttp/1.0';

/** Minimal surface we use from @vercel/sandbox (injectable for tests). */
export type SandboxCommandResult = {
  exitCode: number | null;
  /** Test doubles may set string fields directly. */
  stdout?: string | ((opts?: { signal?: AbortSignal }) => Promise<string>);
  stderr?: string | ((opts?: { signal?: AbortSignal }) => Promise<string>);
  output?: (
    stream?: 'stdout' | 'stderr' | 'both',
    opts?: { signal?: AbortSignal },
  ) => Promise<string>;
};

export type SandboxLike = {
  runCommand(
    command: string,
    args?: string[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SandboxCommandResult>;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
};

export type CreateSandboxFn = (params: {
  timeout: number;
  networkPolicy: 'allow-all';
  persistent: false;
  signal?: AbortSignal;
}) => Promise<SandboxLike>;

export type VercelSandboxHttpRunnerOptions = {
  /** Inject Sandbox.create (tests). Default loads @vercel/sandbox. */
  createSandbox?: CreateSandboxFn;
  /** VM lifetime ms (clamped ≤ 55s). */
  sandboxTimeoutMs?: number;
};

async function readStream(
  value: string | ((opts?: { signal?: AbortSignal }) => Promise<string>) | undefined,
): Promise<string> {
  if (value == null) return '';
  if (typeof value === 'function') return value();
  return value;
}

async function commandOutput(
  cmd: SandboxCommandResult,
): Promise<{ stdout: string; stderr: string }> {
  // Prefer dedicated stdout/stderr (SDK CommandFinished methods or test strings).
  if (typeof cmd.stdout === 'function' || typeof cmd.stdout === 'string') {
    return {
      stdout: await readStream(cmd.stdout),
      stderr: await readStream(cmd.stderr),
    };
  }
  if (typeof cmd.output === 'function') {
    try {
      const both = await cmd.output('both');
      if (typeof both === 'string') {
        return { stdout: both, stderr: '' };
      }
    } catch {
      // fall through
    }
  }
  return { stdout: '', stderr: '' };
}

/**
 * Parse curl -D - style: headers then blank line then body (when combined),
 * or headers-only when body is separate.
 */
export function parseCurlHeaders(headerText: string): {
  status: number;
  contentType?: string;
} {
  const lines = headerText.replace(/\r\n/g, '\n').split('\n');
  let status = 0;
  let contentType: string | undefined;
  for (const line of lines) {
    const m = line.match(/^HTTP\/[\d.]+ (\d{3})/i);
    if (m) {
      status = Number(m[1]);
      continue;
    }
    const ct = line.match(/^content-type:\s*(.+)$/i);
    if (ct) {
      contentType = ct[1].trim();
    }
  }
  return { status, contentType };
}

function clampSandboxTimeout(ms: number | undefined): number {
  const n =
    ms == null || !Number.isFinite(ms)
      ? DEFAULT_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS
      : Math.floor(ms);
  if (n < 5_000) return 5_000;
  if (n > MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS) {
    return MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS;
  }
  return n;
}

async function defaultCreateSandbox(params: {
  timeout: number;
  networkPolicy: 'allow-all';
  persistent: false;
  signal?: AbortSignal;
}): Promise<SandboxLike> {
  const { Sandbox } = await import('@vercel/sandbox');
  const sb = await Sandbox.create({
    timeout: params.timeout,
    networkPolicy: params.networkPolicy,
    persistent: params.persistent,
    signal: params.signal,
  });
  return sb as unknown as SandboxLike;
}

export class VercelSandboxHttpRunner implements HttpFetchRunner {
  private readonly createSandbox: CreateSandboxFn;
  private readonly sandboxTimeoutMs: number;
  private createPromise: Promise<SandboxLike> | null = null;
  private sandbox: SandboxLike | null = null;
  private closed = false;

  constructor(opts: VercelSandboxHttpRunnerOptions = {}) {
    this.createSandbox = opts.createSandbox ?? defaultCreateSandbox;
    this.sandboxTimeoutMs = clampSandboxTimeout(opts.sandboxTimeoutMs);
  }

  private async ensureSandbox(signal?: AbortSignal): Promise<SandboxLike> {
    if (this.closed) {
      throw new Error('http runner is closed');
    }
    if (this.sandbox) return this.sandbox;
    if (!this.createPromise) {
      this.createPromise = this.createSandbox({
        timeout: this.sandboxTimeoutMs,
        networkPolicy: 'allow-all',
        persistent: false,
        signal,
      })
        .then((sb) => {
          // Always retain the instance so close() can stop even if we closed mid-create.
          this.sandbox = sb;
          if (this.closed) {
            throw new Error('http runner is closed');
          }
          return sb;
        })
        .catch((err) => {
          // Leave this.sandbox set if create succeeded then closed (close stops it).
          // Only clear latch when create itself failed with no sandbox retained.
          if (!this.sandbox) {
            this.createPromise = null;
          }
          throw err;
        });
    }
    return this.createPromise;
  }

  async get(input: HttpFetchGetInput): Promise<HttpFetchGetResult> {
    if (this.closed) {
      throw new Error('http runner is closed');
    }
    if (input.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const sb = await this.ensureSandbox(input.signal);
    const maxTimeSec = Math.max(1, Math.ceil(input.timeoutMs / 1000));
    const maxBytes = Math.max(0, Math.floor(input.maxBytes));

    if (input.head) {
      const cmd = await sb.runCommand(
        'curl',
        [
          '-sS',
          '-I',
          '--max-time',
          String(maxTimeSec),
          '--max-redirs',
          '0',
          '-A',
          BUILTIN_HTTP_USER_AGENT,
          input.url,
        ],
        { signal: input.signal, timeoutMs: input.timeoutMs + 2000 },
      );
      const { stdout, stderr } = await commandOutput(cmd);
      if (cmd.exitCode !== 0 && !stdout.trim()) {
        throw new Error(
          stderr.trim() || `curl exit ${cmd.exitCode ?? 'unknown'}`,
        );
      }
      const { status, contentType } = parseCurlHeaders(stdout);
      return {
        status: status || (cmd.exitCode === 0 ? 200 : 0),
        contentType,
        body: '',
      };
    }

    // Write body to file; headers on stdout via -D -
    const bodyPath = `/tmp/inv-http-body-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    const cmd = await sb.runCommand(
      'curl',
      [
        '-sS',
        '-D',
        '-',
        '-o',
        bodyPath,
        '--max-time',
        String(maxTimeSec),
        '--max-redirs',
        '0',
        '-A',
        BUILTIN_HTTP_USER_AGENT,
        input.url,
      ],
      { signal: input.signal, timeoutMs: input.timeoutMs + 2000 },
    );
    const { stdout, stderr } = await commandOutput(cmd);
    if (cmd.exitCode !== 0 && !stdout.includes('HTTP/')) {
      throw new Error(
        stderr.trim() || `curl exit ${cmd.exitCode ?? 'unknown'}`,
      );
    }

    const { status, contentType } = parseCurlHeaders(stdout);

    // Read body with byte cap via head -c
    let body = '';
    let truncated = false;
    if (maxBytes > 0) {
      const readCmd = await sb.runCommand(
        'head',
        ['-c', String(maxBytes + 1), bodyPath],
        { signal: input.signal, timeoutMs: 10_000 },
      );
      const out = await commandOutput(readCmd);
      const raw = out.stdout;
      if (raw.length > maxBytes) {
        body = raw.slice(0, maxBytes);
        truncated = true;
      } else {
        body = raw;
      }
    }

    // Best-effort cleanup
    try {
      await sb.runCommand('rm', ['-f', bodyPath], { timeoutMs: 5_000 });
    } catch {
      // ignore
    }

    return {
      status: status || 0,
      contentType,
      body,
      truncated,
    };
  }

  /**
   * Idempotent stop. Always drains in-flight create so abort-during-cold-start
   * cannot orphan a microVM until TTL.
   */
  async close(): Promise<void> {
    if (this.closed) {
      // Second close: still try to stop if a prior close raced create completion.
      await this.stopSandboxIfAny();
      return;
    }
    this.closed = true;
    const pending = this.createPromise;
    this.createPromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        // Create failed or rejected because closed mid-create — sandbox may still
        // have been assigned in the create .then for stop below.
      }
    }
    await this.stopSandboxIfAny();
  }

  private async stopSandboxIfAny(): Promise<void> {
    const sb = this.sandbox;
    this.sandbox = null;
    if (!sb) return;
    try {
      await sb.stop();
    } catch {
      // ignore stop errors
    }
  }
}

/** Factory used by the agent route when env enables sandbox mode. */
export function createVercelSandboxHttpRunner(
  opts: VercelSandboxHttpRunnerOptions = {},
): HttpFetchRunner {
  return new VercelSandboxHttpRunner(opts);
}
