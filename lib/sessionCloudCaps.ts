/**
 * Client-safe cloud session limits.
 * Shared by server validation and host pre-PUT trim.
 * Do not import server/db modules from here.
 */
import { parseInitialCwd } from './agent/workPath';

/**
 * Per-message UTF-8 ceiling (ring-slot / bridge contract).
 *
 * REAL transport ceiling, not an arbitrary budget: it equals the fixed-size
 * `ring_slot.MAX_MSG_LEN = 262144` (`[MAX_MSG_LEN]u8`) Wasm ring buffer. Raising
 * a message past this CANNOT go out on the harness — it would need to grow Wasm
 * memory, so it ships ONLY together with the owning change:
 * `native/harness/src/ring_slot.zig` + `native/harness/src/bridge.zig` + the zig
 * test that asserts `MAX_MSG_LEN`, in the SAME unit. Do not hoist this number on
 * its own.
 */
export const HARNESS_SESSION_MAX_MSG_BYTES = 262_144;

/** Opaque client SessionSnapshot.id max length. */
export const HARNESS_SESSION_SNAPSHOT_ID_MAX = 512;

/** Reject raw PUT bodies larger than this (8 MiB). */
export const HARNESS_SESSION_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Max serialized size of the reserved `meta` object on a session record.
 * `meta` is schema-typed reserved (#411/#412): only the reserved P1 keys are
 * allowed, and their combined JSON size is capped so a record can never balloon
 * or smuggle large payloads under `meta`.
 *
 * Generous-cap rework (parent #506, phase A #507): raised 20 480 → 1 MiB so
 * `meta` is a real per-session carrier — a locked persona snapshot (up to
 * `PERSONA_SNAPSHOT_MAX_BYTES` = 256 KiB), attached-skill slugs, and future
 * background-agent / async-workflow / scratchbook state all fit in the single
 * validated `meta` JSON. Redis/DB per-record limits are far above 1 MiB; the cap
 * is still enforced at write (and unknown keys still rejected).
 */
export const HARNESS_SESSION_MAX_META_BYTES = 1_048_576;

/**
 * Max byte size of a `meta.personaSnapshot` value (parent #485 lock, phase 1 #486,
 * generous-cap rework #507). The snapshot is the AGENTS-style persona text locked
 * into a session at first use so a mid-session persona edit never rewrites an
 * in-flight session. It rides in session `meta` (device-switch replay) and counts
 * toward `HARNESS_SESSION_MAX_META_BYTES`. 256 KiB is a comfortable AGENTS-style
 * doc; 16 KiB was arbitrary.
 */
export const PERSONA_SNAPSHOT_MAX_BYTES = 262_144;

/**
 * Max length (chars) of a Redis-safe opaque id / `activeSandboxId`. Raised 128 →
 * 512 (phase A #507) — keys tolerate far longer. The companion
 * `REDIS_SAFE_OPAQUE_ID_RE` quantifier was bumped in the SAME file («{1,128}» →
 * «{1,512}»); both are used by `validateMetaFields` for `activeSandboxId` /
 * `personaId` and by every store-key validator.
 */
export const REDIS_SAFE_OPAQUE_ID_MAX = 512;

/**
 * Redis-safe opaque id charset (tenant/user/session ids, and the session-carrier
 * `meta.activeSandboxId`). Client-safe mirror so the DOM host / repository can
 * sanitize `activeSandboxId` without importing the server-only
 * `lib/sessions/sessionStore.ts`. These ids live inside `:`-delimited Redis
 * Keyspace segments and a `KEYS` prefix glob, so Redis glob/metachars
 * (`* ? [ ]`) and `:` itself are rejected.
 */
export const REDIS_SAFE_OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;

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

