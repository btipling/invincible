/**
 * Vercel Sandbox–backed HttpFetchRunner (hop-B egress) — attach-only.
 * Product path: Sandbox.get({ name, resume: true }) + extendTimeout; close never stops.
 * Never create or get-or-create; never stop or delete here (lifecycle = userSandboxInstance / host env name).
 */

import type {
  HttpFetchGetInput,
  HttpFetchGetResult,
  HttpFetchRunner,
} from './httpFetchTypes';
import {
  EXTEND_THROTTLE_MS,
  withTransientRetry,
} from '../sandbox/resilience';

export const BUILTIN_HTTP_USER_AGENT = 'InvincibleBuiltinHttp/1.0';

/**
 * Default idle extendTimeout — same family as Workspace attach
 * (`USER_SANDBOX_IDLE_TIMEOUT_MS` = 30m). Inlined so hop-B does not import
 * the tenancy instance domain / drizzle graph (mirror FS vercelClient).
 */
export const DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS = 1_800_000;

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
  /** Present on real SDK; attach runner never calls stop. */
  stop?(opts?: { signal?: AbortSignal }): Promise<unknown>;
  extendTimeout?(
    durationMs: number,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export type GetSandboxParams = {
  name: string;
  resume?: boolean;
  signal?: AbortSignal;
};

export type GetSandboxFn = (params: GetSandboxParams) => Promise<SandboxLike>;

export type VercelSandboxHttpRunnerOptions = {
  /** Durable instance name (Settings HTTP instance or host env). Required. */
  name: string;
  /** Inject Sandbox.get (tests). Default loads @vercel/sandbox. */
  getSandbox?: GetSandboxFn;
  /** Idle extendTimeout ms (default 30m — USER_SANDBOX_IDLE family). */
  idleTimeoutMs?: number;
  /**
   * Minimum gap (ms) between throttled mid-turn `extendTimeout` heartbeats.
   * Default `EXTEND_THROTTLE_MS` (5 min). Injectable for tests.
   */
  extendThrottleMs?: number;
};

/**
 * Read stdout/stderr from a Sandbox CommandFinished (or test double).
 *
 * Real @vercel/sandbox CommandFinished exposes `stdout`/`stderr`/`output` as
 * **methods** that must keep `this`. Extracting `cmd.stdout` and calling it
 * unbound throws: `Cannot read properties of undefined (reading 'output')`.
 */
export async function commandOutput(
  cmd: SandboxCommandResult,
): Promise<{ stdout: string; stderr: string }> {
  // String fields (unit-test doubles).
  if (typeof cmd.stdout === 'string' || typeof cmd.stderr === 'string') {
    return {
      stdout: typeof cmd.stdout === 'string' ? cmd.stdout : '',
      stderr: typeof cmd.stderr === 'string' ? cmd.stderr : '',
    };
  }

  // SDK methods — always call with receiver so `this.output` works.
  if (typeof cmd.stdout === 'function') {
    const stdoutFn = cmd.stdout as (
      this: SandboxCommandResult,
      opts?: { signal?: AbortSignal },
    ) => Promise<string>;
    const stderrFn =
      typeof cmd.stderr === 'function'
        ? (cmd.stderr as (
            this: SandboxCommandResult,
            opts?: { signal?: AbortSignal },
          ) => Promise<string>)
        : null;
    return {
      stdout: await stdoutFn.call(cmd),
      stderr: stderrFn ? await stderrFn.call(cmd) : '',
    };
  }

  if (typeof cmd.output === 'function') {
    try {
      const outputFn = cmd.output as (
        this: SandboxCommandResult,
        stream?: 'stdout' | 'stderr' | 'both',
        opts?: { signal?: AbortSignal },
      ) => Promise<string>;
      const both = await outputFn.call(cmd, 'both');
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
  location?: string;
} {
  const lines = headerText.replace(/\r\n/g, '\n').split('\n');
  let status = 0;
  let contentType: string | undefined;
  let location: string | undefined;
  for (const line of lines) {
    const m = line.match(/^HTTP\/[\d.]+ (\d{3})/i);
    if (m) {
      // With -D -, intermediate proxy 100-continue etc. may appear; keep last status.
      status = Number(m[1]);
      continue;
    }
    const ct = line.match(/^content-type:\s*(.+)$/i);
    if (ct) {
      contentType = ct[1].trim();
      continue;
    }
    const loc = line.match(/^location:\s*(.+)$/i);
    if (loc) {
      location = loc[1].trim();
    }
  }
  return { status, contentType, location };
}

function clampIdleTimeout(ms: number | undefined): number {
  const n =
    ms == null || !Number.isFinite(ms)
      ? DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS
      : Math.floor(ms);
  if (n < 5_000) return 5_000;
  if (n > DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS) {
    return DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS;
  }
  return n;
}

async function defaultGetSandbox(params: GetSandboxParams): Promise<SandboxLike> {
  const { Sandbox } = await import('@vercel/sandbox');
  const sb = await Sandbox.get({
    name: params.name,
    resume: params.resume ?? true,
    signal: params.signal,
  });
  return sb as unknown as SandboxLike;
}

export class VercelSandboxHttpRunner implements HttpFetchRunner {
  private readonly name: string;
  private readonly getSandbox: GetSandboxFn;
  private readonly idleTimeoutMs: number;
  private attachPromise: Promise<SandboxLike> | null = null;
  private sandbox: SandboxLike | null = null;
  private closed = false;
  private lastExtendAt = 0;
  private readonly extendThrottleMs: number;

  constructor(opts: VercelSandboxHttpRunnerOptions) {
    const name = opts.name?.trim();
    if (!name) {
      throw new Error('HTTP sandbox instance name is required');
    }
    this.name = name;
    this.getSandbox = opts.getSandbox ?? defaultGetSandbox;
    this.idleTimeoutMs = clampIdleTimeout(opts.idleTimeoutMs);
    this.extendThrottleMs =
      opts.extendThrottleMs == null
        ? EXTEND_THROTTLE_MS
        : Math.max(0, Math.floor(opts.extendThrottleMs));
  }

  private async bestEffortExtend(sb: SandboxLike): Promise<void> {
    if (typeof sb.extendTimeout !== 'function') return;
    try {
      await sb.extendTimeout(this.idleTimeoutMs);
    } catch {
      // best-effort — never fail the turn
    }
    this.lastExtendAt = Date.now();
  }

  /** Throttled mid-turn heartbeat so long turns do not idle-stop from forget. */
  private async maybeExtend(sb: SandboxLike): Promise<void> {
    if (Date.now() - this.lastExtendAt < this.extendThrottleMs) return;
    await this.bestEffortExtend(sb);
  }

  /** Drop a handle that is no longer trustworthy so the next get re-attaches. */
  private invalidateHandle(): void {
    this.sandbox = null;
    this.attachPromise = null;
  }

  /** Bounded transient retry around a hop-B VM command (curl / head). */
  private runRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withTransientRetry(fn, {
      signal,
      onExhaustedRetryable: () => this.invalidateHandle(),
    });
  }

  private async ensureSandbox(signal?: AbortSignal): Promise<SandboxLike> {
    if (this.closed) {
      throw new Error('http runner is closed');
    }
    if (this.sandbox) return this.sandbox;
    if (!this.attachPromise) {
      this.attachPromise = this.getSandbox({
        name: this.name,
        resume: true,
        signal,
      })
        .then(async (sb) => {
          this.sandbox = sb;
          if (this.closed) {
            throw new Error('http runner is closed');
          }
          await this.bestEffortExtend(sb);
          return sb;
        })
        .catch((err) => {
          if (!this.sandbox) {
            this.attachPromise = null;
          }
          throw err;
        });
    }
    return this.attachPromise;
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
    // Attach does not probe separately (locked): the first VM command below
    // already runs inside the shared transient retry, absorbing any boot window
    // on the first get of the call.
    await this.maybeExtend(sb);
    const maxTimeSec = Math.max(1, Math.ceil(input.timeoutMs / 1000));
    const maxBytes = Math.max(0, Math.floor(input.maxBytes));

    if (input.head) {
      const cmd = await this.runRetry(
        () =>
          sb.runCommand(
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
          ),
        input.signal,
      );
      const { stdout, stderr } = await commandOutput(cmd);
      if (cmd.exitCode !== 0 && !stdout.trim()) {
        throw new Error(
          stderr.trim() || `curl exit ${cmd.exitCode ?? 'unknown'}`,
        );
      }
      const { status, contentType, location } = parseCurlHeaders(stdout);
      return {
        status: status || (cmd.exitCode === 0 ? 200 : 0),
        contentType,
        body: '',
        ...(location ? { location } : {}),
      };
    }

    // Write body to file; headers on stdout via -D -
    const bodyPath = `/tmp/inv-http-body-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    // Cap transfer size at the hop-B layer (not only post-download head -c).
    // Without --max-filesize, curl can write unbounded bytes until --max-time.
    const cmd = await this.runRetry(
      () =>
        sb.runCommand(
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
            '--max-filesize',
            String(Math.max(1, maxBytes)),
            '-A',
            BUILTIN_HTTP_USER_AGENT,
            input.url,
          ],
          { signal: input.signal, timeoutMs: input.timeoutMs + 2000 },
        ),
      input.signal,
    );
    const { stdout, stderr } = await commandOutput(cmd);
    if (cmd.exitCode !== 0 && !stdout.includes('HTTP/')) {
      throw new Error(
        stderr.trim() || `curl exit ${cmd.exitCode ?? 'unknown'}`,
      );
    }

    const { status, contentType, location } = parseCurlHeaders(stdout);

    // Read body with byte cap via head -c
    let body = '';
    let truncated = false;
    if (maxBytes > 0) {
      const readCmd = await this.runRetry(
        () =>
          sb.runCommand(
            'head',
            ['-c', String(maxBytes + 1), bodyPath],
            { signal: input.signal, timeoutMs: 120_000 },
          ),
        input.signal,
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
      ...(location ? { location } : {}),
    };
  }

  /**
   * Idempotent release. Drop handle + best-effort extendTimeout.
   * Never stop/delete durable HTTP instances.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.releaseHandle();
      return;
    }
    this.closed = true;
    const pending = this.attachPromise;
    this.attachPromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        // attach failed mid-flight — handle may still be set
      }
    }
    await this.releaseHandle();
  }

  private async releaseHandle(): Promise<void> {
    const sb = this.sandbox;
    this.sandbox = null;
    if (!sb) return;
    await this.bestEffortExtend(sb);
  }
}

/** Factory used by the agent route when env enables sandbox mode + attach name. */
export function createVercelSandboxHttpRunner(
  opts: VercelSandboxHttpRunnerOptions,
): HttpFetchRunner {
  return new VercelSandboxHttpRunner(opts);
}
