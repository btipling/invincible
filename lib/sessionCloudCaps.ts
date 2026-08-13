/**
 * Client-safe cloud session limits.
 * Shared by server validation and host pre-PUT trim.
 * Do not import server/db modules from here.
 */
import { parseInitialCwd } from './agent/workPath';

/** Align with bridge MAX_MSG_LEN (UTF-8 bytes) — native/harness/src/bridge.zig. */
export const HARNESS_SESSION_MAX_MSG_BYTES = 262_144;

/** Opaque client SessionSnapshot.id max length. */
export const HARNESS_SESSION_SNAPSHOT_ID_MAX = 128;

/** Reject raw PUT bodies larger than this (~2 MiB). */
export const HARNESS_SESSION_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Max serialized size of the reserved `meta` object on a session record.
 * `meta` is schema-typed reserved (#411/#412): only the reserved P1 keys are
 * allowed, and their combined JSON size is capped so a record can never balloon
 * or smuggle large payloads under `meta`.
 *
 * Raised 4096 → 20480 (parent #485 lock, phase 1 #486): a persona snapshot
 * (`meta.personaSnapshot`, up to `PERSONA_SNAPSHOT_MAX_BYTES` = 16 KiB) must fit
 * alongside the other reserved keys in the single validated `meta` JSON, so the
 * whole-meta budget carries a 16 KiB snapshot + 4 KiB other-reserved headroom.
 * The lift is additive for all session records (no schema/Redis change).
 */
export const HARNESS_SESSION_MAX_META_BYTES = 20_480;

/**
 * Max byte size of a `meta.personaSnapshot` value (parent #485 lock, phase 1 #486).
 * The snapshot is the AGENTS-style persona text locked into a session at first
 * use so a mid-session persona edit never rewrites an in-flight session. It rides
 * in session `meta` (device-switch replay) and counts toward
 * `HARNESS_SESSION_MAX_META_BYTES`. 16 KiB allows a personable AGENTS-style doc.
 */
export const PERSONA_SNAPSHOT_MAX_BYTES = 16_384;

/** Max length (chars) of a Redis-safe opaque id / `activeSandboxId`. */
export const REDIS_SAFE_OPAQUE_ID_MAX = 128;

/**
 * Redis-safe opaque id charset (tenant/user/session ids, and the session-carrier
 * `meta.activeSandboxId`). Client-safe mirror so the DOM host / repository can
 * sanitize `activeSandboxId` without importing the server-only
 * `lib/sessions/sessionStore.ts`. These ids live inside `:`-delimited Redis
 * Keyspace segments and a `KEYS` prefix glob, so Redis glob/metachars
 * (`* ? [ ]`) and `:` itself are rejected.
 */
export const REDIS_SAFE_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isRedisSafeOpaqueId(s: unknown): s is string {
  return typeof s === 'string' && REDIS_SAFE_OPAQUE_ID_RE.test(s);
}

/**
 * Workspace-relative cwd hygiene shared by server validation and host trim/parse.
 * Keeps only non-empty workspace-relative strings; drops host-absolute, drive/UNC,
 * control characters, and non-strings. `..`-style traversal is intentionally NOT
 * rejected at P1 (no known workspace root yet; deferred to GAP-2/#410 + P3/#403).
 */
export function sanitizeSessionCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined;
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  // Host-absolute / UNC / Windows drive — would 400 every agent turn if sticky.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return undefined;
  }
  // C0 controls + DEL (break annotations / SSE if ever reflected).
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The exact workspace-relative cwd value that is SAFE to send to `/api/agent`
 * AND to persist (P1/GAP-1, review #453 residual). After `sanitizeSessionCwd`,
 * the value is renormalized via `parseInitialCwd` so a P1-legal-but-escaping
 * segment (`..`, `a/../../b`, `.`-collapsible paths) is collapsed to the same
 * normalized workspace-relative form the request path would send — or dropped
 * (`undefined`) when it cannot be sent safely (host-absolute, drive/UNC, control
 * chars, or `..` that escapes the workspace root). Using this BOTH for the
 * request cwd and for the value persisted to `meta.logicalCwd` (trim/apply) means
 * a record can never keep an escaping `..` that diverges from what the agent
 * actually receives across devices.
 */
export function normalizeSessionCwd(cwd: unknown): string | undefined {
  const clean = sanitizeSessionCwd(cwd);
  if (clean === undefined) return undefined;
  const parsed = parseInitialCwd(clean);
  if (!parsed.ok) return undefined;
  return parsed.cwd;
}

