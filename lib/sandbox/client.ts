import {
  SandboxHttpError,
  type ExecResult,
  type ListDirResult,
  type ReadFileResult,
  type SandboxClientOptions,
  type WriteFileResult,
} from './types';
import { normalizeBaseUrl } from './config';

const DEFAULT_TIMEOUT_MS = 35_000;

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
  exec: (
    body: {
      cmd: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
    },
    init?: { signal?: AbortSignal },
  ) => Promise<ExecResult>;
};

export function createSandboxClient(opts: SandboxClientOptions): SandboxClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const token = opts.token;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function postJson<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeout);
    const onOuterAbort = () => controller.abort();
    if (init?.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
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
        const errMsg =
          data &&
          typeof data === 'object' &&
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : `Sandbox request failed (${res.status})`;
        // Never include token in thrown message
        const safe = errMsg.includes(token) ? errMsg.split(token).join('[redacted]') : errMsg;
        throw new SandboxHttpError(safe, res.status);
      }

      return data as T;
    } catch (err) {
      if (err instanceof SandboxHttpError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
      }
      const message = err instanceof Error ? err.message : 'Sandbox request failed';
      const safe = message.includes(token) ? message.split(token).join('[redacted]') : message;
      throw new SandboxHttpError(safe, 502);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', onOuterAbort);
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
    exec: (body, init) => postJson<ExecResult>('/v1/exec', body, init),
  };
}
