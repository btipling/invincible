/** Mirror of sandbox protocol (BYO daemon health.version; stdin requires v2+). */

export type SandboxDirEntry = {
  name: string;
  type: 'file' | 'dir' | 'other';
};

export type ListDirResult = { entries: SandboxDirEntry[] };

/** On-disk fingerprint (additive; optional when daemon/backend omits). */
export type FileFingerprint = {
  mtimeMs?: number;
  size?: number;
};

export type ReadFileResult = { content: string; truncated?: boolean } & FileFingerprint;

export type WriteFileResult = { ok: true; bytes: number } & FileFingerprint;

export type StrReplaceResult = {
  ok: true;
  path: string;
  replacements: number;
  bytes: number;
} & FileFingerprint;

export type StatResult = {
  path: string;
  type: 'file' | 'dir' | 'other';
  /**
   * On-disk mtime when the backend can measure it.
   * Omit when unknown — never invent `0` (phase 2 degrades on missing mtime).
   */
  mtimeMs?: number;
  size: number;
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
  /**
   * Server-owned allowlisted env merged into every `/v1/exec` body.
   * Only GH_TOKEN / GITHUB_TOKEN should be supplied. Never from the model.
   */
  execEnv?: Record<string, string>;
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
