/**
 * Expected sandbox daemon revision, mirrored from `sandbox/constants.mjs`
 * `INVINCIBLE_SANDBOX_DAEMON_VERSION` — a parity test fails if they diverge.
 * Bump BOTH in the same PR whenever daemon tool surface / jail / budgets change
 * in a way the deployed Next backend relies on. `version` (protocol) is a
 * separate, independent integer.
 */
export const EXPECTED_SANDBOX_DAEMON_VERSION = 1;

/** Header the client sends on every `/v1/*` request. Mirrors constants.mjs. */
export const EXPECTED_DAEMON_VERSION_HEADER = 'x-invincible-expected-daemon-version';

/** Stable `code` for the out-of-date error. Mirrors constants.mjs. */
export const SANDBOX_DAEMON_OUT_OF_DATE_CODE = 'SANDBOX_DAEMON_OUT_OF_DATE';

/**
 * Locked exact error string — must match `sandbox/constants.mjs`
 * `sandboxDaemonOutOfDateError`. Model-visible and operator-greppable.
 */
export function sandboxDaemonOutOfDateError(running: number, expected: number): string {
  return `Sandbox daemon out of date (running ${running}, expected ${expected}). Update and restart the sandbox process.`;
}
