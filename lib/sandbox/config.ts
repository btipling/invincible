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

/** Maximum total hits returned by the search tool. */
export const SEARCH_MAX_RESULTS = 200;
/** Per-file hit ceiling passed to rg --max-count. */
export const SEARCH_PER_FILE_MAX_COUNT = 20;
/** Skip files larger than this (rg --max-filesize). */
export const SEARCH_MAX_FILESIZE = 1_048_576; // 1 MiB
/** rg --max-filesize arg — accepts raw size or a human suffix like '1M'. */
export const SEARCH_MAX_FILESIZE_STR = '1M';
/** Clip a single hit's text to this many UTF-8 bytes. */
export const SEARCH_LINE_MAX_BYTES = 200;
/** Hard cap on the total result bytes before finalize. */
export const SEARCH_RESULT_MAX_BYTES = 65536; // 64 KiB
/** Bounded timeout for a single rg spawn. */
export const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Exec result summary window: first N lines of each stdout/stderr stream shown
 * in the model-visible result. NEW cap. Matches the `read_file` default limit
 * pattern as a "window into more".
 */
export const EXEC_LOG_HEAD_LINES = 10;
export const EXEC_LOG_TAIL_LINES = 10;
/**
 * Cap on a single line shown inside the exec-result summary window. A
 * pathological single stdio line (e.g. one huge minified JSON line) is clipped
 * so the summary stays compact and — critically — never pushes the `log:`
 * pointer past `TOOL_RESULT_MAX_CHARS` (which would truncate it off). NEW cap.
 */
export const EXEC_SUMMARY_LINE_MAX_BYTES = 4096;
/**
 * Defense-in-depth ceiling for the on-disk `exec` log file. The daemon already
 * caps each stdout/stderr stream at `MAX_STDIO_BYTES` (4 MiB) so worst-case
 * combined is 8 MiB — this cap only bites if a daemon cap is raised without
 * updating this one. Under `MAX_READ_WRITE_BYTES` (16 MiB). NEW cap.
 */
export const EXEC_LOG_MAX_BYTES = 8_388_608; // 8 MiB

export function clampExecTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs == null || Number.isNaN(Number(timeoutMs))) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  const n = Math.floor(Number(timeoutMs));
  if (n < 1) return 1;
  if (n > MAX_EXEC_TIMEOUT_MS) return MAX_EXEC_TIMEOUT_MS;
  return n;
}
