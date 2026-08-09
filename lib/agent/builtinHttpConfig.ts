/**
 * Env config for builtin HTTPS fetch via Vercel Sandbox (hop-B).
 * Server-only — never NEXT_PUBLIC_*.
 * Attach-only when enabled: tenancy on uses Settings HTTP instance;
 * tenancy off requires BUILTIN_HTTP_INSTANCE_NAME (never create on hot path).
 */

export const BUILTIN_HTTP_FETCH_OFF = 'off' as const;
export const BUILTIN_HTTP_FETCH_SANDBOX = 'sandbox' as const;

export type BuiltinHttpFetchMode =
  | typeof BUILTIN_HTTP_FETCH_OFF
  | typeof BUILTIN_HTTP_FETCH_SANDBOX;

export const DEFAULT_BUILTIN_HTTP_TIMEOUT_MS = 120_000; // 2 min
export const MAX_BUILTIN_HTTP_TIMEOUT_MS = 1_800_000; // 30 min
export const MIN_BUILTIN_HTTP_TIMEOUT_MS = 1;

export const DEFAULT_BUILTIN_HTTP_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_BUILTIN_HTTP_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Legacy env clamp range for BUILTIN_HTTP_SANDBOX_TIMEOUT_MS (docs/tests).
 * Product attach idle uses USER_SANDBOX_IDLE_TIMEOUT_MS via the runner.
 */
export const MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS = 1_800_000;

export type BuiltinHttpConfig = {
  enabled: boolean;
  mode: BuiltinHttpFetchMode;
  timeoutMs: number;
  maxBytes: number;
  /** Legacy VM-lifetime env clamp (not used for attach create). */
  sandboxTimeoutMs: number;
  /**
   * Tenancy-off host attach name (`BUILTIN_HTTP_INSTANCE_NAME`).
   * Empty when unset — route fail-closed when builtin enabled and tenancy off.
   */
  instanceNameTenancyOff: string;
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

  const instanceNameTenancyOff = (env.BUILTIN_HTTP_INSTANCE_NAME ?? '').trim();

  return {
    enabled: mode === BUILTIN_HTTP_FETCH_SANDBOX,
    mode,
    timeoutMs,
    maxBytes,
    sandboxTimeoutMs,
    instanceNameTenancyOff,
  };
}
