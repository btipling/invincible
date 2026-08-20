import {
  SandboxHttpError,
  type ExecResult,
  type ListDirResult,
  type ReadFileResult,
  type SandboxClientOptions,
  type StatResult,
  type StrReplaceErrorWindow,
  type WriteFileResult,
  type StrReplaceResult,
} from './types';
import {
  EXEC_TIMEOUT_BUFFER_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_SANDBOX_PROTOCOL_STDIN,
  normalizeBaseUrl,
} from './config';
import {
  EXPECTED_SANDBOX_DAEMON_VERSION,
  EXPECTED_DAEMON_VERSION_HEADER,
  SANDBOX_DAEMON_OUT_OF_DATE_CODE,
  sandboxDaemonOutOfDateError,
} from './daemonVersion';

const DEFAULT_TIMEOUT_MS = 45_000;

/** C0 controls + DEL — reject roots that could break tool-result framing / joins. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Bounded health probe (backs `checkDaemonCurrent` / `workspaceRoot`). A
 * blackholed BYO daemon must not pin a request (or a resolve path) for the full
 * 45s tool timeout; 10s is ample for a reachable daemon.
 */
const HEALTH_PROBE_TIMEOUT_MS = 10_000;

/** Parsed `GET /health` body of interest to the client. */
type HealthInfo = { version: number; daemonVersion: number; workspaceRoot: string | null };

/** Per-client-instance health cache (null = not yet probed). */
type HealthCache = { health: HealthInfo | null; inflight: Promise<HealthInfo> | null };

/**
 * Gated, fail-closed parse of `GET /health` workspaceRoot. Only a current daemon
 * (>= 2) whose body carries an **absolute** POSIX path with no control
 * characters — and not the bare root `"/"` (which would make every absolute
 * path "escape" on reading) nor any `..` segment — is trusted. Everything else
 * (relative, drive-aware, `..`, bare `/`, fake/partial bodies) parses to `null`,
 * so a bogus root never surfaces from `workspaceRoot()`.
 */
function parseWorkspaceRoot(raw: unknown, daemonVersion: number): string | null {
  if (daemonVersion < 2) return null;
  if (typeof raw !== 'string') return null;
  const root = raw.trim();
  if (root.length === 0) return null;
  if (CONTROL_CHARS.test(root)) return null;
  if (!root.startsWith('/')) return null;
  if (root === '/') return null;
  if (root.split('/').includes('..')) return null;
  // Canonical realpath jail root: no repeated slashes, no `..` handled above,
  // and no trailing slash. A realpath never emits `//` (a manual join/crafting
  // can, and `//ws`/`/ws/` would not share keys with `normalizeWorkspaceRoot`),
  // so reject instead of silently smuggling a non-canonical root.
  if (root.includes('//') || root.endsWith('/')) return null;
  return root;
}

export type SandboxClient = {
  listDir: (path?: string, init?: { signal?: AbortSignal }) => Promise<ListDirResult>;
  readFile: (
    path: string,
    maxBytes?: number,
    init?: { signal?: AbortSignal },
  ) => Promise<ReadFileResult>;
  writeFile: (
    path: string,
    content: string,
    mkdir?: boolean,
    init?: { signal?: AbortSignal },
  ) => Promise<WriteFileResult>;
  strReplace: (
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
    init?: { signal?: AbortSignal },
  ) => Promise<StrReplaceResult>;
  /** Cheap metadata for create-vs-update / freshness re-check (no content). */
  stat: (path: string, init?: { signal?: AbortSignal }) => Promise<StatResult>;
  exec: (
    body: {
      cmd: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      /** Optional stdin body (heredoc) — fed without a shell. */
      stdin?: string;
      /** Alias for stdin. */
      heredoc?: string;
      /** Reserved — clients merge construction execEnv; tools must not set. */
      env?: Record<string, string>;
    },
    init?: { signal?: AbortSignal },
  ) => Promise<ExecResult>;
  /**
   * Fail-fast: reject when the running daemon's `daemonVersion` < expected
   * (or the daemon predates the field). Used by runAgent preflight so a turn
   * errors out before the first tool call. Absent on non-HTTP backends
   * (Vercel Sandbox SDK), which have no daemon `daemonVersion` to compare.
   */
  checkDaemonCurrent?: () => Promise<void>;
  /**
   * The per-binding jail workspace root `R`. Returned by both backends so path
   * code has one accessor. **Non-throwing:** a health-probe failure, an
   * out-of-date daemon, or a stale/partial health body yields `null` — never a
   * throw (so `resolveAgentSandbox` never 403s on an operational daemon outage).
   */
  workspaceRoot?: (init?: { signal?: AbortSignal }) => Promise<string | null>;
  /**
   * Non-secret daemon protocol snapshot from `GET /health`. **Never** includes
   * `workspaceRoot`. Absent on non-HTTP backends (Vercel). **Non-throwing:**
   * probe fail / 426 / abort → `null`.
   */
  daemonInfo?: (
    init?: { signal?: AbortSignal },
  ) => Promise<{ version: number; daemonVersion: number } | null>;
  /**
   * Optional lifecycle hook for ephemeral backends (Vercel Sandbox).
   * BYO HTTP client omits this. Idempotent when present.
   */
  close?: () => Promise<void>;
};

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

export function execAbortTimeoutMs(timeoutMs?: number): number | undefined {
  if (timeoutMs == null || Number.isNaN(Number(timeoutMs))) return undefined;
  const clamped = Math.min(
    Math.max(1, Math.floor(Number(timeoutMs))),
    MAX_EXEC_TIMEOUT_MS,
  );
  return clamped + EXEC_TIMEOUT_BUFFER_MS;
}

export function createSandboxClient(opts: SandboxClientOptions): SandboxClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const token = opts.token;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execEnv = normalizeExecEnv(opts.execEnv);
  const expectedDaemonVersion =
    opts.expectedDaemonVersion ?? EXPECTED_SANDBOX_DAEMON_VERSION;
  const healthCache: HealthCache = { health: null, inflight: null };

  function redactedMessage(message: string): string {
    return message.includes(token) ? message.split(token).join('[redacted]') : message;
  }

  async function withTimeoutFetch(
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeout);
    const onOuterAbort = () => controller.abort();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Probe `GET /health` once per client, then reuse the cached body. A stale
   * daemon with no `daemonVersion` field reports running `0` (out-of-date);
   * a missing **protocol** version is a hard 502 (restart the daemon). On
   * error nothing is cached, so the next call retries the probe.
   */
  async function fetchHealth(
    init?: { signal?: AbortSignal },
  ): Promise<HealthInfo> {
    if (healthCache.health) return healthCache.health;
    if (healthCache.inflight) return healthCache.inflight;

    healthCache.inflight = (async () => {
      try {
        const res = await withTimeoutFetch(
          `${baseUrl}/health`,
          {
            method: 'GET',
            signal: init?.signal,
          },
          HEALTH_PROBE_TIMEOUT_MS,
        );
        let data: unknown = null;
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          try {
            data = await res.json();
          } catch {
            data = null;
          }
        } else {
          await res.text().catch(() => '');
        }
        if (!res.ok) {
          throw new SandboxHttpError(
            `Sandbox health check failed (${res.status})`,
            res.status >= 400 && res.status < 600 ? res.status : 502,
          );
        }
        const rec = (data ?? {}) as {
          version?: unknown;
          daemonVersion?: unknown;
          workspaceRoot?: unknown;
        };
        const version =
          typeof rec.version === 'number' && Number.isFinite(rec.version)
            ? rec.version
            : NaN;
        if (!Number.isFinite(version) || version < 1) {
          throw new SandboxHttpError(
            'Sandbox health response missing protocol version — restart the BYO daemon',
            502,
          );
        }
        const daemonVersion =
          typeof rec.daemonVersion === 'number' && Number.isFinite(rec.daemonVersion)
            ? Math.floor(rec.daemonVersion)
            : 0;
        // Gated, fail-closed parse: only a current daemon (>= 2) whose health
        // carries an absolute, control-char-free root path is trusted. Relative /
        // drive / `..` / bare-`/` / fake bodies parse to null.
        const workspaceRoot = parseWorkspaceRoot(
          rec.workspaceRoot,
          daemonVersion,
        );
        const health: HealthInfo = { version, daemonVersion, workspaceRoot };
        healthCache.health = health;
        return health;
      } catch (err) {
        if (err instanceof SandboxHttpError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
        }
        const message = err instanceof Error ? err.message : 'Sandbox health check failed';
        throw new SandboxHttpError(redactedMessage(message), 502);
      } finally {
        healthCache.inflight = null;
      }
    })();

    return healthCache.inflight;
  }

  /**
   * Gate: reject when the daemon is behind the expected revision. Clears the
   * health cache on out-of-date so the next call re-probes (e.g. after the
   * operator upgrades/restarts the daemon) instead of pinning the stale value.
   */
  async function ensureDaemonCurrent(
    init?: { signal?: AbortSignal },
  ): Promise<void> {
    const health = await fetchHealth(init);
    if (health.daemonVersion >= expectedDaemonVersion) return;
    healthCache.health = null; // refresh on out-of-date
    throw new SandboxHttpError(
      sandboxDaemonOutOfDateError(health.daemonVersion, expectedDaemonVersion),
      426,
      SANDBOX_DAEMON_OUT_OF_DATE_CODE,
    );
  }

  /** Backward-compatible protocol-version accessor (exec stdin gate). */
  async function ensureProtocolVersion(
    init?: { signal?: AbortSignal },
  ): Promise<number> {
    return (await fetchHealth(init)).version;
  }

  /**
   * Parse additive `window` / `windows` fields from a str_replace error body.
   * Normalizes both single-window (not-found) and multi-window (multi-match)
   * into a single `StrReplaceErrorWindow[]` array. Returns undefined when
   * neither field is present (non-str_replace errors, old daemons).
   */
  function parseStrReplaceWindows(
    data: Record<string, unknown>,
  ): StrReplaceErrorWindow[] | undefined {
    const windowsRaw = data['windows'];
    if (Array.isArray(windowsRaw)) {
      // Return whatever the daemon sent — even an empty array (defensive;
      // with the indexOf-based daemon match loop this should not happen, but
      // a daemon bug must not cause the client to fall through to the `window`
      // key and silently drop the windows).
      return windowsRaw
        .filter(
          (w): w is Record<string, unknown> =>
            w != null && typeof w === 'object' && typeof (w as Record<string, unknown>).content === 'string',
        )
        .map((w) => ({
          content: String(w.content),
          ...(typeof w.offset === 'number' ? { offset: w.offset } : {}),
          ...(typeof w.line === 'number' ? { line: w.line } : {}),
          ...(typeof w.truncated === 'boolean' ? { truncated: w.truncated } : {}),
          ...(typeof w.size === 'number' ? { size: w.size } : {}),
        }));
    }
    const windowRaw = data['window'];
    if (windowRaw != null && typeof windowRaw === 'object') {
      const w = windowRaw as Record<string, unknown>;
      if (typeof w.content === 'string') {
        return [
          {
            content: String(w.content),
            ...(typeof w.offset === 'number' ? { offset: w.offset } : {}),
            ...(typeof w.line === 'number' ? { line: w.line } : {}),
            ...(typeof w.truncated === 'boolean' ? { truncated: w.truncated } : {}),
            ...(typeof w.size === 'number' ? { size: w.size } : {}),
          },
        ];
      }
    }
    return undefined;
  }

  async function postJson<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
    timeoutMs?: number,
  ): Promise<T> {
    // Any FS tool call fails loudly when the daemon is out of date (goal 3).
    // Uses the cached health probe; on an outdated daemon it re-probes.
    await ensureDaemonCurrent(init);

    const url = `${baseUrl}${path}`;
    try {
      const res = await withTimeoutFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            [EXPECTED_DAEMON_VERSION_HEADER]: String(expectedDaemonVersion),
          },
          body: JSON.stringify(body ?? {}),
          signal: init?.signal,
        },
        timeoutMs,
      );

      let data: unknown = null;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try {
          data = await res.json();
        } catch {
          data = null;
        }
      } else {
        await res.text().catch(() => '');
      }

      if (!res.ok) {
        const rec = (data ?? {}) as {
          error?: unknown;
          code?: unknown;
          running?: unknown;
          expected?: unknown;
        };
        // 426 (or a daemon that signals SANDBOX_DAEMON_OUT_OF_DATE) → exact error.
        if (res.status === 426 || rec.code === SANDBOX_DAEMON_OUT_OF_DATE_CODE) {
          const running =
            typeof rec.running === 'number' ? rec.running : 0;
          const expected =
            typeof rec.expected === 'number' ? rec.expected : expectedDaemonVersion;
          const msg =
            typeof rec.error === 'string'
              ? rec.error
              : sandboxDaemonOutOfDateError(running, expected);
          healthCache.health = null; // refresh so a same-turn retry can re-probe
          throw new SandboxHttpError(
            redactedMessage(msg),
            426,
            SANDBOX_DAEMON_OUT_OF_DATE_CODE,
          );
        }
        const errMsg =
          typeof rec.error === 'string'
            ? rec.error
            : `Sandbox request failed (${res.status})`;
        // Parse additive window/windows fields from error body (str_replace excerpt).
        const strReplaceWindows = parseStrReplaceWindows(
          (data ?? {}) as Record<string, unknown>,
        );
        // Never include token in thrown message
        throw new SandboxHttpError(
          redactedMessage(errMsg),
          res.status,
          'SANDBOX_HTTP',
          strReplaceWindows,
        );
      }

      return data as T;
    } catch (err) {
      if (err instanceof SandboxHttpError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
      }
      const message = err instanceof Error ? err.message : 'Sandbox request failed';
      throw new SandboxHttpError(redactedMessage(message), 502);
    }
  }

  return {
    checkDaemonCurrent: () => ensureDaemonCurrent(),
    /**
     * Non-throwing per-binding root accessor. A down/unreachable daemon, a
     * pre-v2 daemon, or a partial health body all degrade to `null` so resolve
     * never 403s on an operational outage (FS tool turns still gate 502/426).
     */
    workspaceRoot: async (init?): Promise<string | null> => {
      try {
        return (await fetchHealth(init)).workspaceRoot;
      } catch {
        return null;
      }
    },
    daemonInfo: async (init?): Promise<{ version: number; daemonVersion: number } | null> => {
      try {
        const h = await fetchHealth(init);
        return { version: h.version, daemonVersion: h.daemonVersion };
      } catch {
        return null;
      }
    },
    listDir: (path = '.', init) => postJson<ListDirResult>('/v1/list_dir', { path }, init),
    readFile: (path, maxBytes, init) =>
      postJson<ReadFileResult>(
        '/v1/read_file',
        maxBytes != null ? { path, maxBytes } : { path },
        init,
      ),
    writeFile: (path, content, mkdir, init) =>
      postJson<WriteFileResult>(
        '/v1/write_file',
        { path, content, ...(mkdir ? { mkdir: true } : {}) },
        init,
      ),
    strReplace: (path, oldString, newString, replaceAll, init) =>
      postJson<StrReplaceResult>(
        '/v1/str_replace',
        {
          path,
          old_string: oldString,
          new_string: newString,
          ...(replaceAll ? { replace_all: true } : {}),
        },
        init,
      ),
    stat: (path, init) => postJson<StatResult>('/v1/stat', { path }, init),
    exec: async (body, init) => {
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
        const version = await ensureProtocolVersion(init);
        if (version < MIN_SANDBOX_PROTOCOL_STDIN) {
          throw new SandboxHttpError(
            `Sandbox daemon protocol v${version} does not support exec stdin/heredoc ` +
              `(need v${MIN_SANDBOX_PROTOCOL_STDIN}+). Restart/upgrade the BYO daemon.`,
            400,
          );
        }
      }
      // Prefer stdin; drop heredoc alias so the wire body is canonical.
      const { heredoc: _heredoc, ...rest } = body ?? { cmd: '' };
      const wire = {
        ...rest,
        ...(typeof stdinRaw === 'string' ? { stdin: stdinRaw } : {}),
      };
      return postJson<ExecResult>(
        '/v1/exec',
        execEnv ? { ...wire, env: execEnv } : wire,
        init,
        // Client abort deadline follows the request's (already clamped) timeoutMs,
        // plus a buffer so the daemon's own kill lands first (TIMED_OUT, not 504).
        execAbortTimeoutMs(body?.timeoutMs),
      );
    },
  };
}
