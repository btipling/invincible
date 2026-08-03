/** Invincible sandbox HTTP protocol version (health.version). */
export const INVINCIBLE_SANDBOX_PROTOCOL = 1;

/** Parent #45 / #46 budgets */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
export const MAX_EXEC_TIMEOUT_MS = 30_000;
export const MIN_EXEC_TIMEOUT_MS = 1;

/** read_file / write_file hard cap */
export const MAX_READ_WRITE_BYTES = 256 * 1024;

/** stdout / stderr cap per exec stream */
export const MAX_STDIO_BYTES = 32 * 1024;

export const DEFAULT_LISTEN = '127.0.0.1:8787';
