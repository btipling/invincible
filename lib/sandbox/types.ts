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
  /**
   * Expected daemon `daemonVersion` for the out-of-date gate. Defaults to
   * `EXPECTED_SANDBOX_DAEMON_VERSION`. Sending a higher value than the running
   * daemon makes every tool call fail closed with 426.
   */
  expectedDaemonVersion?: number;
};

/** Window into a file excerpt returned on str_replace errors. */
export type StrReplaceErrorWindow = {
  /** Excerpt content, capped at STR_REPLACE_EXCERPT_MAX_BYTES. */
  content: string;
  /** 1-based line of the first line in the excerpt. */
  offset?: number;
  /** 1-based line of the match (multi-match windows only). */
  line?: number;
  /** True when the excerpt (or window content) was truncated. */
  truncated?: boolean;
  /** Byte length of the full file (not-found head excerpt only). */
  size?: number;
};

export type SandboxHttpErrorCode = 'SANDBOX_HTTP' | 'SANDBOX_DAEMON_OUT_OF_DATE';

export class SandboxHttpError extends Error {
  readonly status: number;
  readonly code: SandboxHttpErrorCode;
  /** Windows from a str_replace error response (undefined when absent / not a str_replace error). */
  readonly strReplaceWindows?: StrReplaceErrorWindow[];

  constructor(
    message: string,
    status: number,
    code: SandboxHttpErrorCode = 'SANDBOX_HTTP',
    strReplaceWindows?: StrReplaceErrorWindow[],
  ) {
    super(message);
    this.name = 'SandboxHttpError';
    this.status = status;
    this.code = code;
    this.strReplaceWindows = strReplaceWindows;
  }
}
