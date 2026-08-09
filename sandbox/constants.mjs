/**
 * Invincible sandbox HTTP protocol version (health.version).
 * v2: exec accepts optional stdin/heredoc (multi-line input without a shell).
 * Clients that send stdin must require health.version >= 2 so stale daemons
 * cannot silently ignore the field.
 */
export const INVINCIBLE_SANDBOX_PROTOCOL = 2;

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

export const DEFAULT_LISTEN = '127.0.0.1:8787';
