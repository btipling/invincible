/**
 * Env config for builtin HTTPS fetch via Vercel Sandbox (hop-B).
 * Server-only — never NEXT_PUBLIC_*.
 *
 * Always-available: HTTP tools auto-attach when the user has a running
 * Settings HTTP instance (create one under Settings → Sandbox). No env
 * kill switch — the presence of a durable HTTP instance is the gate.
 * Attach-only: never create on the hot path.
 */

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
  timeoutMs: number;
  maxBytes: number;
  /** Legacy VM-lifetime env clamp (not used for attach create). */
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
 * Parse builtin HTTP budget env knobs (timeout + byte caps).
 * No enable flag — HTTP tools are always available when the user
 * has a running Settings HTTP instance.
 */
export function resolveBuiltinHttpConfig(
  env: Record<string, string | undefined> = process.env,
): BuiltinHttpConfig {
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

  return { timeoutMs, maxBytes, sandboxTimeoutMs };
}
