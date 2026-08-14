/**
 * Client-safe cloud session limits.
 * Shared by server validation and host pre-PUT trim.
 * Do not import server/db modules from here.
 */
import { parseInitialCwd } from './agent/workPath';

/** Align with bridge MAX_MSG_LEN (UTF-8 bytes) — native/harness/src/bridge.zig. */
export const HARNESS_SESSION_MAX_MSG_BYTES = 262_144;

/** Opaque client SessionSnapshot.id max length. */
export const HARNESS_SESSION_SNAPSHOT_ID_MAX = 512;

/**
 * Function-carried full-record / envelope body cap (wire-safe). Every write or
 * read that crosses a Vercel Function request/response must stay under the real
 * 4.5 MB Function payload ceiling (`413 FUNCTION_PAYLOAD_TOO_LARGE` /
 * `FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`). This is that bound for the one-shot
 * rollforward full-record PUT/GET (`/api/sessions/:id`) and the host's rollforward
 * trim (`trimForCloudPut`). Kept at 2 MiB (the pre-#514 value) so a JSON record
 * (messages + reserved `meta`) never balloons toward the 4.5 MB Function wire.
 *
 * The generous **8 MiB** transcript-object ceiling lives separately in
 * `HARNESS_SESSION_MAX_BODY_BYTES` and applies ONLY to Blob **objects** ferried
 * client→Blob (phase 0 #515) — never to a Function body (parent #512 lock: "8 MiB
 * is a Blob object ceiling, not a Function body"; #514 review: "any cap raised
 * must never turn a function-carried write/read into a one-shot >4.5 MB body").
 */
export const HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Reject raw PUT/GET bodies larger than this on the **Blob transcript-object**
 * path (generous 8 MiB object ceiling). Phase 0 (#515) moved the transcript to
 * Blob objects ferried by client→Blob uploads, so this caps an **object**, not a
 * one-shot Function body — the Vercel Function 4.5 MB request/response ceiling
 * is the inviolable wire bound and does not apply to Blob objects. A
 * function-carried write/read must only ever carry a per-wire body under that
 * 4.5 MB limit (`HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES`, the envelope/meta path).
 */
export const HARNESS_SESSION_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Single-source skill-slug charset (parent #495 lock, shared with the phase-3
 * slash parser and the phase-1 `meta.attachedSkills` validator). Lives here in
 * the client-safe seam so `lib/sessions/sessionStore.ts` can validate attached
 * slugs WITHOUT importing the server-only `lib/tenancy/userSkills` module
 * (layering: sessionStore ↛ userSkills). `userSkills` re-imports/re-exports it.
 * Lowercase start; digits, underscore AND hyphen allowed; ≤ 128 chars.
 */
export const SKILL_SLUG_RE = /^[a-z][a-z0-9_-]{0,127}$/;

/**
 * Hard cap on the number of slugs a single `meta.attachedSkills` JSON array may
 * carry (phase 1 #514). Prevents an attacker from stuffing an unbounded list of
 * slug strings (each only cheaply bounded by the slug charset) under a reserved
 * meta key. Fail-closed above this count (400 `INVALID_META`).
 */
export const HARNESS_SESSION_MAX_ATTACHED_SKILLS = 32;

/**
 * Max serialized size of the reserved `meta` object on a session record.
 * `meta` is schema-typed reserved (#411/#412): only the reserved P1 keys are
 * allowed, and their combined JSON size is capped so a record can never balloon
 * or smuggle large payloads under `meta`.
 *
 * Raised 4096 → 20480 (parent #485 lock, phase 1 #486), then to 1 MiB (parent
 * #513, phase 1 #514): a persona snapshot (`meta.personaSnapshot`, up to
 * `PERSONA_SNAPSHOT_MAX_BYTES` = 512 KiB) and the `attachedSkills` JSON string
 * must fit alongside the other reserved keys in the single validated `meta`
 * JSON. The 1 MiB whole-meta budget stays well under the Vercel Function 4.5 MB
 * request/response ceiling so an envelope GET/PUT through the small Redis
 * envelope carrier never 500s with `FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`.
 * The lift is additive for all session records (no schema/Redis change).
 */
export const HARNESS_SESSION_MAX_META_BYTES = 1024 * 1024;

/**
 * Max byte size of a `meta.personaSnapshot` value (parent #485 lock, phase 1 #486).
 * The snapshot is the AGENTS-style persona text locked into a session at first
 * use so a mid-session persona edit never rewrites an in-flight session. It rides
 * in session `meta` (device-switch replay) and counts toward
 * `HARNESS_SESSION_MAX_META_BYTES`. 512 KiB allows a generous personable AGENTS-style doc;
 * raised to 512 KiB (parent #513 phase 1 #514) for a generous persona body while
 * still fitting inside the raised 1 MiB whole-`meta` budget.
 */
export const PERSONA_SNAPSHOT_MAX_BYTES = 512 * 1024;

/** Max length (chars) of a Redis-safe opaque id / `activeSandboxId`. */
export const REDIS_SAFE_OPAQUE_ID_MAX = 512;

/**
 * Redis-safe opaque id charset (tenant/user/session ids, and the session-carrier
 * `meta.activeSandboxId`). Client-safe mirror so the DOM host / repository can
 * sanitize `activeSandboxId` without importing the server-only
 * `lib/sessions/sessionStore.ts`. These ids live inside `:`-delimited Redis
 * Keyspace segments and a `KEYS` prefix glob, so Redis glob/metachars
 * (`* ? [ ]`) and `:` itself are rejected. `{1,512}` is raised in lockstep with
 * `REDIS_SAFE_OPAQUE_ID_MAX` (parent #513 phase 1 #514).
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

