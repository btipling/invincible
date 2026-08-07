/**
 * Injectable egress runner for builtin HTTP tools (phase 1 interface; phase 2 = Vercel Sandbox).
 * Parent #225 / phase #226.
 */

export type HttpFetchGetInput = {
  /** Absolute https URL already passed assertSafePublicHttps. */
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type HttpFetchGetResult = {
  status: number;
  contentType?: string;
  body: string;
  truncated?: boolean;
};

/**
 * Hop-B egress. Implementations must not follow redirects (or surface 3xx without body trust).
 * Soft-fail is the caller's job; runners may throw (tools catch).
 */
export type HttpFetchRunner = {
  get(input: HttpFetchGetInput): Promise<HttpFetchGetResult>;
  /** Optional HEAD; when omitted, http_head tool is not registered. */
  head?(input: {
    url: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    contentType?: string;
    contentLength?: string;
  }>;
  /** Release resources (Sandbox VM). Idempotent. */
  close?(): Promise<void> | void;
};
