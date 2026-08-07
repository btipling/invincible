/**
 * Env config for builtin HTTPS fetch via Vercel Sandbox.
 * Server-only — never NEXT_PUBLIC_*.
 */

export const BUILTIN_HTTP_FETCH_OFF = 'off' as const;
export const BUILTIN_HTTP_FETCH_SANDBOX = 'sandbox' as const;

export type BuiltinHttpFetchMode =
  | typeof BUILTIN_HTTP_FETCH_OFF
  | typeof BUILTIN_HTTP_FETCH_SANDBOX;

export const DEFAULT_BUILTIN_HTTP_TIMEOUT_MS = 10_000;
export const MAX_BUILTIN_HTTP_TIMEOUT_MS = 20_000;
export const MIN_BUILTIN_HTTP_TIMEOUT_MS = 1;

export const DEFAULT_BUILTIN_HTTP_MAX_BYTES = 65_536;
export const MAX_BUILTIN_HTTP_MAX_BYTES = 256 * 1024;

/** Sandbox.create lifetime clamp — fits route maxDuration 60s + cleanup. */
export const MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS = 55_000;
export const DEFAULT_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS = 55_000;

export type BuiltinHttpConfig = {
  enabled: boolean;
  mode: BuiltinHttpFetchMode;
  timeoutMs: number;
  maxBytes: number;
  sandboxTimeoutMs: number;
};

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * Parse builtin HTTP env. Default off.
 * Only `sandbox` enables tools.
 */
export function resolveBuiltinHttpConfig(
  env: Record<string, string | undefined> = process.env,
): BuiltinHttpConfig {
  const raw = (env.BUILTIN_HTTP_FETCH ?? '').trim().toLowerCase();
  const mode: BuiltinHttpFetchMode =
    raw === BUILTIN_HTTP_FETCH_SANDBOX
      ? BUILTIN_HTTP_FETCH_SANDBOX
      : BUILTIN_HTTP_FETCH_OFF;

  const timeoutMs = clampInt(
    env.BUILTIN_HTTP_TIMEOUT_MS,
    DEFAULT_BUILTIN_HTTP_TIMEOUT_MS,
    MIN_BUILTIN_HTTP_TIMEOUT_MS,
    MAX_BUILTIN_HTTP_TIMEOUT_MS,
  );

  const maxBytes = clampInt(
    env.BUILTIN_HTTP_MAX_BYTES,
    DEFAULT_BUILTIN_HTTP_MAX_BYTES,
    1,
    MAX_BUILTIN_HTTP_MAX_BYTES,
  );

  const sandboxTimeoutMs = clampInt(
    env.BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
    DEFAULT_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
    5_000,
    MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
  );

  return {
    enabled: mode === BUILTIN_HTTP_FETCH_SANDBOX,
    mode,
    timeoutMs,
    maxBytes,
    sandboxTimeoutMs,
  };
}
