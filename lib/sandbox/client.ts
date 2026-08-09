import {
  SandboxHttpError,
  type ExecResult,
  type ListDirResult,
  type ReadFileResult,
  type SandboxClientOptions,
  type StatResult,
  type WriteFileResult,
  type StrReplaceResult,
} from './types';
import {
  EXEC_TIMEOUT_BUFFER_MS,
  MAX_EXEC_TIMEOUT_MS,
  MIN_SANDBOX_PROTOCOL_STDIN,
  normalizeBaseUrl,
} from './config';

const DEFAULT_TIMEOUT_MS = 45_000;

/** Cached health.version per client instance (null = not yet probed). */
type ProtocolCache = { version: number | null; inflight: Promise<number> | null };

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

/**
 * Client-side HTTP abort deadline for `/v1/exec`, derived from the request's
 * (already clamped) `timeoutMs` + `EXEC_TIMEOUT_BUFFER_MS`. Falls back to the
 * client default (`defaultTimeout`) when omitted/NaN so short commands keep the
 * existing fast abort. The buffer keeps the client abort strictly after the
 * daemon's own timeout kill, so `timedOut: true` reaches the model (TIMED_OUT)
 * rather than surfacing as a client 504.
 */
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
  const protocolCache: ProtocolCache = { version: null, inflight: null };

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
   * Probe GET /health once per client. Stale v1 daemons report version 1 and
   * must not receive stdin (they would ignore it silently).
   */
  async function ensureProtocolVersion(init?: { signal?: AbortSignal }): Promise<number> {
    if (protocolCache.version != null) return protocolCache.version;
    if (protocolCache.inflight) return protocolCache.inflight;

    protocolCache.inflight = (async () => {
      try {
        const res = await withTimeoutFetch(`${baseUrl}/health`, {
          method: 'GET',
          signal: init?.signal,
        });
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
        const version =
          data &&
          typeof data === 'object' &&
          typeof (data as { version?: unknown }).version === 'number'
            ? (data as { version: number }).version
            : NaN;
        if (!Number.isFinite(version) || version < 1) {
          throw new SandboxHttpError(
            'Sandbox health response missing protocol version — restart the BYO daemon',
            502,
          );
        }
        protocolCache.version = version;
        return version;
      } catch (err) {
        if (err instanceof SandboxHttpError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
        }
        const message = err instanceof Error ? err.message : 'Sandbox health check failed';
        throw new SandboxHttpError(redactedMessage(message), 502);
      } finally {
        protocolCache.inflight = null;
      }
    })();

    return protocolCache.inflight;
  }

  async function postJson<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    try {
      const res = await withTimeoutFetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
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
        const errMsg =
          data &&
          typeof data === 'object' &&
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : `Sandbox request failed (${res.status})`;
        // Never include token in thrown message
        throw new SandboxHttpError(redactedMessage(errMsg), res.status);
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
