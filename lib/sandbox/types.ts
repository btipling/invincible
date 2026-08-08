/** Mirror of sandbox protocol v1 (phase 1 / #46). */

export type SandboxDirEntry = {
  name: string;
  type: 'file' | 'dir' | 'other';
};

export type ListDirResult = { entries: SandboxDirEntry[] };

export type ReadFileResult = { content: string; truncated?: boolean };

export type WriteFileResult = { ok: true; bytes: number };

export type StrReplaceResult = {
  ok: true;
  path: string;
  replacements: number;
  bytes: number;
};

export type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
};

export type SandboxClientOptions = {
  baseUrl: string;
  token: string;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout when no signal (ms). */
  timeoutMs?: number;
};

export class SandboxHttpError extends Error {
  readonly status: number;
  readonly code = 'SANDBOX_HTTP' as const;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SandboxHttpError';
    this.status = status;
  }
}
