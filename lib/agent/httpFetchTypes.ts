/**
 * Injectable egress runner for builtin HTTP tools.
 * Phase 2 implements with Vercel Sandbox; phase 1 tests use fakes.
 */

export type HttpFetchGetInput = {
  /** Already policy-checked absolute https URL. */
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** When true, request HEAD only (no body trust). */
  head?: boolean;
};

export type HttpFetchGetResult = {
  status: number;
  contentType?: string;
  body: string;
  truncated?: boolean;
  /** Absolute or relative Location header when present (3xx). */
  location?: string;
};

/**
 * Hop-B runner. One instance per agent turn.
 * Implementations must create ≤1 VM and support concurrent get via single-flight.
 */
export type HttpFetchRunner = {
  get(input: HttpFetchGetInput): Promise<HttpFetchGetResult>;
  /** Stop underlying sandbox (wraps SDK stop / async dispose). Idempotent. */
  close(): Promise<void>;
};
