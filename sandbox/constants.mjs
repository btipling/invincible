/**
 * Invincible sandbox HTTP protocol version (health.version).
 * v2: exec accepts optional stdin/heredoc (multi-line input without a shell).
 * Clients that send stdin must require health.version >= 2 so stale daemons
 * cannot silently ignore the field.
 */
export const INVINCIBLE_SANDBOX_PROTOCOL = 2;

/**
 * Monotonic daemon revision, distinct from `INVINCIBLE_SANDBOX_PROTOCOL`.
 * Bump in the SAME PR that changes daemon tool surface / jail / budgets in a way
 * deployed Next relies on. Clients treat a missing `daemonVersion` as 0 (older
 * daemons). Keep the TS mirror `EXPECTED_SANDBOX_DAEMON_VERSION` in
 * `lib/sandbox/daemonVersion.ts` in sync (enforced by a parity test).
 *
 * v2 (this bump): `GET /health` adds the per-binding jail `workspaceRoot`,
 * which deployed Next relies on for abs↔rel path canonicalization.
 */
export const INVINCIBLE_SANDBOX_DAEMON_VERSION = 2;

/** Header the Next backend sends on every `/v1/*` request (string int). */
export const SANDBOX_EXPECTED_DAEMON_VERSION_HEADER = 'x-invincible-expected-daemon-version';

/** Stable `code` for the out-of-date JSON error body. */
export const SANDBOX_DAEMON_OUT_OF_DATE_CODE = 'SANDBOX_DAEMON_OUT_OF_DATE';

/**
 * Locked exact error string. Mirrored in `lib/sandbox/daemonVersion.ts` (client)
 * so both sides match the model-visible contract.
 * @param {number} running
 * @param {number} expected
 */
export function sandboxDaemonOutOfDateError(running, expected) {
  return `Sandbox daemon out of date (running ${running}, expected ${expected}). Update and restart the sandbox process.`;
}

/** Minimum health.version that supports exec stdin/heredoc. */
export const MIN_SANDBOX_PROTOCOL_STDIN = 2;

/** Default exec timeout (ms) when client omits timeoutMs. */
export const DEFAULT_EXEC_TIMEOUT_MS = 300_000; // 5 min

/** Max exec timeout (ms) — 30 min, matches agent route maxDuration. */
export const MAX_EXEC_TIMEOUT_MS = 1_800_000;

export const MIN_EXEC_TIMEOUT_MS = 1;

/** read_file / write_file hard cap */
export const MAX_READ_WRITE_BYTES = 16 * 1024 * 1024; // 16 MiB

/** stdout / stderr cap per exec stream */
export const MAX_STDIO_BYTES = 4 * 1024 * 1024; // 4 MiB

/** Max JSON request body (must fit large write_file content). */
export const MAX_JSON_BODY_BYTES = 20 * 1024 * 1024; // 20 MiB

/** str_replace error excerpt window: max bytes for file-head / match-window content. */
export const STR_REPLACE_EXCERPT_MAX_BYTES = 2048; // 2 KiB

/** str_replace multi-match error: max match windows to return. */
export const STR_REPLACE_EXCERPT_MAX_MATCHES = 5;

export const DEFAULT_LISTEN = '127.0.0.1:8787';
