/**
 * Client-safe cloud session limits.
 * Shared by server validation and host pre-PUT trim.
 * Do not import server/db modules from here.
 */

/** Stable machine code when tenancy is off (API returns 404). */
export const CLOUD_SESSION_DISABLED_CODE = 'CLOUD_SESSION_DISABLED';

export const CLOUD_SESSION_DISABLED_ERROR = 'Cloud session sync is disabled.';

/** Align with bridge MAX_MSG_LEN (UTF-8 bytes) — native/harness/src/bridge.zig. */
export const HARNESS_SESSION_MAX_MSG_BYTES = 262_144;

/** Opaque client SessionSnapshot.id max length. */
export const HARNESS_SESSION_SNAPSHOT_ID_MAX = 128;

/** Reject raw PUT bodies larger than this (~2 MiB). */
export const HARNESS_SESSION_MAX_BODY_BYTES = 2 * 1024 * 1024;
