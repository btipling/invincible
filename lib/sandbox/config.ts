/**
 * Only applies when `AGENT_MAX_STEPS` is explicitly set.
 * No product default step ceiling — model-ended loop otherwise.
 * Absurd upper bound so env cannot silently re-introduce a toy 256 wall.
 */
export const MAX_AGENT_MAX_STEPS = 1_000_000;
export const MIN_AGENT_MAX_STEPS = 1;

/** Tool result string returned to the model (not a turn-stop). */
export const TOOL_RESULT_MAX_CHARS = 2_000_000;

/** Soft max for any single tool summary string (display path also uses salient bits). */
export const TOOL_TRACE_SUMMARY_MAX_CHARS = 100_000;

/** Default exec timeout when the model omits timeoutMs. */
export const DEFAULT_EXEC_TIMEOUT_MS = 300_000; // 5 min
/** Hard ceiling for one exec — aligned with route maxDuration (30m). */
export const MAX_EXEC_TIMEOUT_MS = 1_800_000; // 30 min
/**
 * Client-side HTTP abort buffer added to an exec request's `timeoutMs`.
 * Keeps the client abort deadline strictly after the daemon's own timeout kill
 * (which returns `timedOut: true`) so TIMED_OUT reaches the model instead of a
 * client 504. Only used for `/v1/exec`; non-exec calls keep DEFAULT_TIMEOUT_MS.
 */
export const EXEC_TIMEOUT_BUFFER_MS = 5_000;

/**
 * Minimum BYO daemon health.version that supports exec stdin/heredoc.
 * Mirrors sandbox/constants.mjs MIN_SANDBOX_PROTOCOL_STDIN.
 */
export const MIN_SANDBOX_PROTOCOL_STDIN = 2;

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Optional multi-step safety ceiling.
 * @returns `null` when unset/invalid → caller uses model-ended stop (`isLoopFinished`).
 */
export function resolveAgentMaxSteps(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.AGENT_MAX_STEPS?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < MIN_AGENT_MAX_STEPS) return MIN_AGENT_MAX_STEPS;
  if (i > MAX_AGENT_MAX_STEPS) return MAX_AGENT_MAX_STEPS;
  return i;
}

export function clampExecTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs == null || Number.isNaN(Number(timeoutMs))) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  const n = Math.floor(Number(timeoutMs));
  if (n < 1) return 1;
  if (n > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return n;
}
