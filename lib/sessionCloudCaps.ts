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
 * Max objects a transcript `prev` walk may visit (plan #886). Loop/DoS bound
 * on reconstruct **and** worker persist — not a message cap and not a change
 * to the 8 MiB per-object ceiling. NEW generous cap. The head object counts
 * as 1. Persist writes `depth` on worker chunks so it can refuse a 257th
 * object without walking ancestors (adversarial #889).
 */
export const TRANSCRIPT_CHUNK_WALK_MAX = 256;


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
 * Per-turn **inject ceiling** for the attached-skill inject folded into the
 * model system prompt (`skillsPreamble`). Plan #557 / #931: the default inject
 * is a bounded **catalog** (one line per candidate skill — slug + name +
 * description, built from `listUserSkills` summaries; bodies ride the
 * on-demand `fetch_skill` tool), so this value is now a **safety rail over the
 * catalog**, not the default inject. A typical 32+8 one-liner catalog is a
 * few KiB; a maxed CJK name+description library can exceed 256 KiB, so
 * `skillInject` flattens each entry to one line and packs by remaining
 * budget (occupancy 1 may use this full ceiling; the 32+8 count caps are the
 * row ceiling, not a per-line tax) — every resolvable slug still
 * appears. Kept UNCHANGED as the inject ceiling (not raised, not lowered —
 * no human cap-gate triggered).
 *
 * This deliberately differs from the **store** cap (`SKILL_BODY_MAX_BYTES`, 4 MiB):
 * the ON-DISK body may be huge (a skill is staff-of-work, stored once). Because
 * no body is injected at attach time any more, the former attach-time
 * `too_large` / `budget` rejection is retired for the catalog path: an
 * over-256 KiB skill can attach and be catalog-listed, and its body is only
 * ever fetched (truncated to the 256 KiB `SKILL_FETCH_MAX_RETURN_BYTES`
 * return cap).
 */
export const HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES = 256 * 1024;

/**
 * Agent skill tools (phase 3 #516) caps. `find_skill` bounds how many matching
 * summaries it returns to the model in one call (an unbounded listing of every
 * skill could otherwise flood a tool result); `fetch_skill` bounds the per-call
 * **model-return** body so a single fetch of a 4 MiB store-capable skill can
 * never balloon the Gateway payload / model context. This mirrors the phase-2
 * inject-budget discipline (`HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`): the
 * ON-DISK skill body may be large (stored once, staff-of-work), but what crosses
 * the model wire per tool call is capped — a longer body is returned truncated
 * with a prose marker (`…[truncated to N bytes; full body is M bytes — edit in
 * Settings]`), never silently dropped. The untruncated stored body stays
 * editable in Settings; the truncated slice still reaches the client as a
 * `tool_result` preview → `tool_run` row. These tools never write a body to
 * session/meta.
 */
export const SKILL_FIND_RESULT_MAX = 20;
export const SKILL_FETCH_MAX_RETURN_BYTES = 256 * 1024;

/**
 * Per-user authoring ceilings for the built-in `meta_*` tools (phase 1 #531,
 * adversarial-review L5 fix). `createUserPersona` / `createUserSkill` have no
 * store-side N-row ceiling, and the model loop can run many turns — so without
 * a ceiling a single turn could insert an unbounded row count (each skill body
 * up to the 4 MiB store cap) and flood the next `list` / `find_skill` / attached
 * inject. These are gentle per-user ceilings enforced in the TOOL layer
 * (`lib/agent/metaTools.ts`): `*_create` rejects with an error past the ceiling,
 * and `meta_persona_list` / `meta_skill_list` bound their summary output so a
 * huge library never floods a tool result in one call. Pure backend safety
 * bounds — invisible in normal use, no confirm/friction on the happy path
 * (deliberately: authoring stays confirm-free per product decision).
 */
export const META_USER_PERSONAS_MAX = 50;
export const META_USER_SKILLS_MAX = 200;

/**
 * Per-tool `old_string` / `new_string` fragment cap for the literal
 * `meta_skill_str_replace` patch tool (plan for #600). Each fragment a model
 * emits to patch a skill body is bounded here so the tool cannot be used as a
 * backdoor full-body rewrite (each fragment stays within a typical output-token
 * budget). This is a NEW additive cap (generous default at 64 KiB) — it does not
 * relax anything. The **final** patched body is still bounded by the store write
 * cap `SKILL_BODY_MAX_BYTES` (4 MiB, `lib/tenancy/userSkills.ts`), never
 * truncated. Both fragment and patched body ride the `/api/agent` Function wire
 * far below the 4.5 MB Function ceiling.
 */
export const META_SKILL_FRAGMENT_MAX_BYTES = 64 * 1024;

/**
 * Max version rows per skill (plan #711 phase 1). Append-only version history
 * caps the number of stored full-body copies so a tight loop of edits cannot
 * produce unbounded rows per skill. Rollback inserts a new version (itself
 * versioned) and counts toward this cap. NEW generous cap.
 */
export const SKILL_VERSION_MAX = 100;

/**
 * Max version rows per persona (plan #726, source #534). Append-only version
 * history caps the number of stored full-body copies so a tight loop of edits
 * cannot produce unbounded rows per persona. Rollback inserts a new version
 * (itself versioned) and counts toward this cap. NEW generous cap — mirrors
 * `SKILL_VERSION_MAX`; personas hold ≤ 16 KiB bodies (smaller than skills'
 * 4 MiB), so ~1.6 MiB/persona even at cap (~80 MiB/user at
 * `META_USER_PERSONAS_MAX` = 50) — trivial Postgres. No existing cap changed.
 */
export const PERSONA_VERSION_MAX = 100;

/**
 * Max number of skills a user may set as always-on (plan #720 phase 2).
 * Always-on skills auto-attach to every new session regardless of persona.
 * NEW generous cap — 8 catalog lines (name ≤ 200, description ≤ 2000). A
 * maxed CJK library of 32 sticky + 8 always-on can exceed the 256 KiB
 * `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` ceiling; catalog assembly
 * packs by remaining budget so occupancy 1 is not chopped. No existing
 * cap changed.
 */
export const USER_ALWAYS_ON_SKILLS_MAX = 8;

/**
 * Max number of recommended skill slugs a persona may carry (plan #720 phase 3).
 * Persists as a JSON array column on `user_personas`. NEW generous cap — a
 * trivial ~500 bytes under the 1 MiB whole-meta cap. No existing cap changed.
 */
export const PERSONA_RECOMMENDED_SKILLS_MAX = 16;

/**
 * Max UTF-8 byte length of the session-owned agent working-notes block
 * (plan #938, source #550 — backend-agents A2). The notes are the agent's own
 * persisted findings/decisions for THIS session, persisted as the reserved
 * `meta.workingNotes` string scalar on the Redis envelope and folded into the
 * model system prompt between the persona and the attached-skills catalog.
 * "A novel is not memory": 32 KiB (~8–16k tokens worst case) bounds the block
 * as a standing per-round inference cost while staying far under the 1 MiB
 * whole-meta budget (`HARNESS_SESSION_MAX_META_BYTES`) and the 4.5 MB Function
 * wire. NEW generous cap — no existing cap value changed → no human gate.
 * Enforced by `sanitizeWorkingNotes` (tool writes reject over-cap with an
 * explicit error — never truncate; read-side poison drops to unset).
 */
export const WORKING_NOTES_MAX_BYTES = 32 * 1024;

/** UTF-8 byte length of a notes block (client-safe — no Node Buffer here). */
function workingNotesByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Client-safe sanitizer for the reserved `meta.workingNotes` block (plan #938).
 * Notes are freeform agent-authored text (findings, paths, decisions), so there
 * is deliberately NO charset restriction — length only. A string is `trim()`ed;
 * an empty result is `undefined` (unset — `update('')` clears). A value whose
 * UTF-8 length exceeds `WORKING_NOTES_MAX_BYTES` is poison → `undefined`
 * (drop-to-unset at read; the tool write path rejects BEFORE persisting, never
 * silently truncates). Non-strings are poison too. Never throws. Shared by the
 * server validator, the worker overlay, the system fold, and the host mirror —
 * no shape drift across the seam.
 */
export function sanitizeWorkingNotes(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!s) return undefined;
  if (workingNotesByteLength(s) > WORKING_NOTES_MAX_BYTES) return undefined;
  return s;
}

/**
 * Parse a stored `meta.attachedSkills` (a JSON-array string of skill slugs) into a
 * slug list. Client-safe single source shared by the host session repository
 * (`cloudMetaFor` / `parseCloudSessionSnapshot`), the server `skillInject`, and the
 * meta validator — no shape drift across the seam. **Fail-closed → []** on any
 * malformed/foreign value; each slug must match `SKILL_SLUG_RE`; duplicates are
 * dropped (insertion order preserved). `undefined` → `[]` (nothing sticky).
 */
export function parseAttachedSkills(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const s of parsed) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/** Serialize a slug set to the sticky `meta.attachedSkills` JSON-array-string form. */
export function serializeAttachedSkills(slugs: string[]): string {
  return JSON.stringify(slugs);
}

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

/**
 * Per-slot status-bar value cap (UTF-8 bytes) — plan #538/#541 (workspace status
 * bar, phase 1). One status slot (sandbox · cwd · git · context) is a short
 * header one-liner; the value rides the Wasm bridge v13 status store. Matches
 * `native/harness/src/bridge.zig` `MAX_STATUS_SLOT_LEN` and
 * `lib/harnessBridge.ts` `MAX_STATUS_SLOT_LEN`. A host push is authoritative:
 * values over this are REJECTED, never silently truncated on the wire.
 */
export const STATUS_SLOT_MAX_BYTES = 96;

/**
 * Server-side min-interval between git-probe executions on GET
 * `/api/harness/status` (plan #538/#540, phase 2). **Per-instance best-effort**
 * (Vercel serverless: no global process clock) — NOT a durable global lock. The
 * **host cadence is the primary throttle**; this cap only blocks a single-path
 * hot loop / stale-tab refresh storm from hammering the sandbox with git exec
 * turns. Generous vs the real host cadence of ~seconds. A request arriving
 * inside the interval gets `{ git: <last>, rate_limited: true, value?: <formatted> }`
 * back without new exec (never 429-spam, never an unbounded exec burst); the
 * host treats a `rate_limited` 200 as KEEP-last (pr #544 #1), so the formatted
 * `value` is included whenever the cached result has a branch/sha; per-slot
 * fail-soft holds on exhaustion (the git slot simply keeps its last value /
 * stays empty).
 */
export const STATUS_PROBE_MIN_INTERVAL_MS = 2000;

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
 * Max length (chars) of a reserved `meta.turnRunId` value (plan #795, backend-agents
 * A1). A Workflow **run id** carried as a session-carrier header is a Redis-safe
 * opaque scalar in the tiny session envelope. **NEW cap** reusing the existing opaque
 * ceiling (`REDIS_SAFE_OPAQUE_ID_MAX`) — no existing cap value changed, no human gate.
 * Far below the 1 MiB whole-meta budget and the 4.5 MB Function wire.
 */
export const TURN_RUN_ID_MAX = REDIS_SAFE_OPAQUE_ID_MAX;

/**
 * Client-safe predicate for a reserved `meta.turnRunId` (plan #795). Accepts only a
 * trimmed string ≤ `TURN_RUN_ID_MAX` that passes `isRedisSafeOpaqueId`
 * (charset `^[A-Za-z0-9_-]{1,512}$`) — a Workflow run id lives in Redis Keyspace
 * segments, so glob/metachars and `:` are rejected through the shared opaque
 * predicate. Fail-closed: returns `undefined` for a non-string, empty/whitespace,
 * over-length, or non-opaque value. Shared by the server validator, which DROPS a
 * poisoned `turnRunId` to unset — never a 400 (same drop-to-unset decision as
 * `selectedModel` / `usage`).
 */
export function sanitizeTurnRunId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!s) return undefined;
  if (s.length > TURN_RUN_ID_MAX) return undefined;
  return isRedisSafeOpaqueId(s) ? s : undefined;
}

/**
 * Reserved `meta.turnStatus` enum members (plan #796, backend-agents A2). Single
 * TS source shared by the server validator (`lib/sessions/sessionStore.ts`) and any
 * host trim/parse — no second string set, so validator and carrier can never drift.
 * `completed` is a **first-class terminal member** (NOT special-cased in the
 * predicate, NOT omitted): writing it is what re-allows the next prompt under the
 * later C15 live-only 409 (#809), so the carrier must accept and preserve it exactly
 * like the other three.
 */
export const TURN_STATUS_VALUES = ['idle', 'running', 'cancelling', 'completed'] as const;
export type TurnStatus = (typeof TURN_STATUS_VALUES)[number];

/**
 * Max length (chars) of a reserved `meta.turnStatus` value (plan #796, backend-agents
 * A2). The status is a fixed enum string; the longest member today is `cancelling`
 * (10 chars). 64 is a **generous NEW ceiling** that constrains a reasonably-sized
 * future enum member while riding the tiny session envelope far below the 1 MiB
 * whole-meta budget (`HARNESS_SESSION_MAX_META_BYTES`) and the 4.5 MB Function wire.
 * The exact-enum check is the primary guard; this byte cap is belt-and-suspenders so
 * a future member can never silently become an oversized carrier. **NEW cap; no
 * existing cap value changed → no human gate.**
 */
export const TURN_STATUS_MAX_BYTES = 64;

/**
 * Client-safe predicate for a reserved `meta.turnStatus` (plan #796, backend-agents
 * A2). Accepts **only** one of the exact enum strings in `TURN_STATUS_VALUES` — no
 * trimming into a member, no case-folding (a padded or `'Running'` value is poison,
 * dropped to unset). Anything else (non-string, empty, uppercase, unknown enum,
 * over-length) → `undefined`. Fail-closed. `completed` is accepted and preserved
 * like the other members. Shared by the server validator, which DROPS a poisoned
 * `turnStatus` to unset — never a 400 (same drop-to-unset decision as `selectedModel`
 * / `usage` / `turnRunId`).
 */
export function sanitizeTurnStatus(value: unknown): TurnStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if (!(TURN_STATUS_VALUES as readonly string[]).includes(value)) return undefined;
  if (value.length > TURN_STATUS_MAX_BYTES) return undefined;
  return value as TurnStatus;
}

/**
 * Max value of a reserved `meta.turnStreamCursor` (plan #797, backend-agents A3).
 * A monotonic **attach/replay offset** for the later `GET .../stream?startIndex=C`
 * (C16 #810) and attach handshake that uses the cursor (E19 #813). **NEW generous
 * cap** far above the parent's 2k-event slow-replay line per turn (see cost lock):
 * 1e9 is ~6 orders of magnitude of headroom while riding the tiny session envelope
 * far below the 1 MiB whole-meta budget (`HARNESS_SESSION_MAX_META_BYTES`) and the
 * 4.5 MB Function wire. **NEW cap; no existing cap value changed → no human gate.**
 */
export const TURN_STREAM_CURSOR_MAX = 1_000_000_000;

/**
 * Client-safe predicate for a reserved `meta.turnStreamCursor` (plan #797,
 * backend-agents A3). Accepts **only** a number that is a **non-negative integer**
 * `≤ TURN_STREAM_CURSOR_MAX` — that excludes negative, `NaN`, `Infinity`/non-finite,
 * non-integer (`0.5`), over-cap, and any non-`number` value (string/number-like,
 * object, `null`, `undefined`). Fail-closed → `undefined`. Shared by the server
 * validator, which DROPS a poisoned `turnStreamCursor` to unset — never a 400 (same
 * drop-to-unset decision as `selectedModel` / `usage` / `turnRunId` / `turnStatus`).
 */
export function sanitizeTurnStreamCursor(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value)) return undefined;
  if (value < 0) return undefined;
  if (value > TURN_STREAM_CURSOR_MAX) return undefined;
  return value;
}

/**
 * Per-session min-interval between turn starts on `POST /api/turns` (plan #809,
 * backend-agents C15). A per-session `Map<string,number>` keyed by `sessionId`
 * advances only on a successful `start()` call — any pre-start gate failure
 * (429 / in-flight 409 / durable 409 / 403 / 503) never burns the window. This
 * is a **soft** abuse guard (survives one Vercel Function invocation), not a
 * durable rate limit. A hard per-user cap would need Redis — out of scope for
 * C15. **NEW generous cap**: 1 second is an eternity for a human but an
 * impassable wall for a loop. No existing cap value changed → **no human gate**.
 */
export const TURN_START_MIN_INTERVAL_MS = 1000;

/**
 * Min-interval between accepted cancels of the **same** run on
 * `POST /api/turns/:runId/cancel` (plan #816, backend-agents G22). A
 * per-process `Map<string,number>` keyed by `sessionId:runId` advances ONLY
 * on an **accepted** cancel — a terminal 409 / ownership 404 / store-or-cancel
 * 503 never burns the window. Same Map+boundedSet shape as the C15 start
 * guard: a **soft** abuse guard (survives one Vercel Function invocation),
 * not a durable rate limit; it bounds `getRun`+PATCH write amplification from
 * a hostile repeat-Stop client on one run. Key includes `runId` so an accepted
 * cancel of wr_1 cannot 429 Stop on wr_2 (adversarial-review #927 pass 8).
 * **NEW generous cap**: 1 second matches `TURN_START_MIN_INTERVAL_MS`. No
 * existing cap value changed → **no human gate**.
 */
export const TURN_CANCEL_MIN_INTERVAL_MS = 1000;

/**
 * How often a start/attach SSE wrapper re-reads `getRun().status` while the
 * client readable is open. `status` is a snapshot (same as the live-only 409
 * gate on `POST /api/turns`): a cancelled/failed/completed run whose producer
 * never closed `getWritable()` would otherwise hang the viewport Busy forever.
 * **NEW generous cap**: 1 second matches `TURN_START_MIN_INTERVAL_MS`. Only
 * runs while a start/attach stream is open. Function-local timer — not a
 * Function body. No existing cap value changed.
 */
export const TURN_STREAM_STATUS_POLL_MS = 1000;

/**
 * Hard wall-clock cap for one durable `/api/turns` run — **1 hour** (plan #923,
 * Bjorn-authorized product lock). Enforced **inside the Workflow step VM**: the
 * `'use workflow'` entry derives a deterministic `deadlineAt` from
 * `getWorkflowMetadata().workflowStartedAt` (runtime-pinned, replay-stable per
 * the SDK docs) + this value; the directive-free `turnLoop` core checks the
 * step boundary and the `'use step'` shells rebuild an
 * `AbortSignal.timeout(remaining)` per attempt from the serialized `deadlineAt`
 * number, so a long/retried model round or tool batch aborts AT the 1-hour line
 * (the #923 4h evidence run's class: retried `modelGenerateStep` ~18 min × 5).
 * The cap value is **code** — no env override (a dynamic value would itself
 * need the same human gate per AGENTS cap governance). The `_TTL_` /
 * `_PROBE_EVERY_` seams below are cache/probe-only and never wire into
 * enforcement. **NEW cap**; no existing cap value changed → no human gate
 * beyond the #923 product lock (== the 1h value itself).
 */
export const TURN_WALL_CLOCK_MAX_MS = 3_600_000;

/**
 * Substitute bound for the **wall** tools-off wrap-up round only
 * (`wrapUp === 'wall'`, adversarial-review #926 Major). The wall wrap-up is
 * exempt from the 1-hour deadline so it can complete AFTER the cap fires —
 * but it must not inherit operator `xhigh` CoT or the default Workflows retry
 * budget with no signal (the 4h evidence class). The bound is
 * `deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS` (a single 1h05 window), not
 * `Date.now() + WRAPUP_MAX` per attempt. The 512-step wrap-up does
 * **not** use this cap; it still carries the 1h `deadlineAt` signal so a
 * wrap-up that starts with remaining > 0 cannot run unbounded past the
 * product lock. **NEW generous cap**; no existing cap value changed →
 * no human gate.
 */
export const TURN_WALL_CLOCK_WRAPUP_MAX_MS = 300_000;

/**
 * **Cache TTL only** — bounds a read-side deadline cache (doc-only seam). Never
 * an enforcement knob: the deadline check uses `workflowStartedAt` +
 * `TURN_WALL_CLOCK_MAX_MS` directly, so an operator cannot shorten the cap via
 * env. **NEW generous cap**; no existing cap value changed → no human gate.
 */
export const TURN_WALL_CLOCK_DEADLINE_TTL_MS = 60_000;

/**
 * **Status-slot probe cadence only** — reserved green-field cadence for a future
 * live elapsed context-slot (`Turn 42m/1h`) during Busy. Never wired to
 * enforcement; the current DoD ships the Turn-ended error line instead.
 * **NEW generous cap**; no existing cap value changed → no human gate.
 */
export const TURN_WALL_CLOCK_PROBE_EVERY_MS = 2_000;

/**
 * Row cap for a message checkpoint (plan #800, backend-agents B6). The checkpoint
 * Blob is a multi-turn `{role, content}` projection; bounding its row count keeps a
 * replay/entity footprint bounded (same order as `TURN_FRESHLEDGER_MAX_GRANTS`,
 * under the parent's 2k-event/slow-replay concern). **NEW generous cap**; no
 * existing cap value changed → **no human gate**. Governs
 * `truncateMessageCheckpoint` in `lib/agent/messageCheckpoint.ts`.
 */
export const TURN_MSG_CHECKPOINT_MAX_ROWS = 4096;

/**
 * Byte cap for a message checkpoint (plan #800, backend-agents B6). The checkpoint
 * is its **own Blob object** — **never the 1 MiB envelope `meta` body**
 * (`HARNESS_SESSION_MAX_META_BYTES`) — so this may exceed that whole-meta budget:
 * 8 MiB aligns with the Redis record body ceiling and is far above any realistic
 * transcript checkpoint. **NEW generous cap**; no existing cap value changed →
 * **no human gate**. Governs `truncateMessageCheckpoint` in `lib/agent/messageCheckpoint.ts`.
 */
export const TURN_MSG_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Per-result excerpt cap for the model-facing message projection (plan #936,
 * source #549). Each persisted `{role:'tool', result}` row is truncated to
 * this many **chars** (UTF-8-safe prefix + explicit marker) so a turn's tool
 * bytes on the wire are bounded — never the 2M-char `TOOL_RESULT_MAX_CHARS`
 * execute-time blob. Peer-locked order (~2k chars at compact time; "paths +
 * status + short excerpt", never `TOOL_RUN_PREVIEW_MAX_CHARS`=100k). `exec`
 * results are already compact summaries with disk-log `log:` pointers, so 2k
 * keeps them near-verbatim; fat `read_file`/`search` results get a head
 * excerpt + marker. **NEW generous cap**; no existing cap value changed →
 * **no human gate**. Enforced in `lib/agent/modelMessages.ts`.
 */
export const MODEL_MSG_TOOL_RESULT_MAX_CHARS = 2_000;

/**
 * Row cap for the model-facing message projection (plan #936). Mirrors
 * `TURN_MSG_CHECKPOINT_MAX_ROWS` (same replay-footprint concern); generous.
 * **NEW generous cap**; no existing cap value changed → **no human gate**.
 * Enforced in `lib/agent/modelMessages.ts`.
 */
export const MODEL_MSG_CHECKPOINT_MAX_ROWS = 4096;

/**
 * Byte cap for the model-facing message projection (plan #936). Mirrors
 * `TURN_MSG_CHECKPOINT_MAX_BYTES`; the projection is its **own Blob object** —
 * never the 1 MiB envelope `meta` — so this may exceed the whole-meta budget.
 * Worst-case seeded history payload stays ~8 MiB ≪ provider body ceilings;
 * per-result truncation keeps real sessions far below. **NEW generous cap**;
 * no existing cap value changed → **no human gate**. Enforced in
 * `lib/agent/modelMessages.ts` + the persist seam's `writeSegment maxBytes`.
 */
export const MODEL_MSG_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Conservative default context window in **tokens** for a model whose context
 * window is published by neither catalog source (plan #944, source #551 — A3
 * fold budget). Near the low end of modern catalog windows so a small-window
 * model is never over-fed; never a fabricated large number and never a fake
 * `% of window` (the #547 honesty lock). **NEW generous cap**; no existing
 * cap value changed → no human gate. Consumed by
 * `lib/agent/contextWindow.ts` + `lib/agent/contextBudget.ts`.
 */
export const CONTEXT_WINDOW_DEFAULT_TOKENS = 200_000;

/**
 * Pi-style completion-reserve floor (plan #944). The fold budget is
 * `window − reserve`; the reserve covers the completion plus system/tool
 * overhead. The effective reserve is
 * `floor(max(CONTEXT_RESERVE_MIN_TOKENS, CONTEXT_RESERVE_FRACTION × window))`
 * (peer-locked Pi/OMP default `max(16384, 0.15 × window)`). **NEW cap**; no
 * existing cap value changed → no human gate. Consumed by
 * `lib/agent/contextBudget.ts` `foldBudgetTokens`.
 */
export const CONTEXT_RESERVE_MIN_TOKENS = 16_384;

/**
 * Fractional completion reserve (plan #944) — 15% of the model window,
 * per the Pi-style rule `max(CONTEXT_RESERVE_MIN_TOKENS, 0.15 × window)`.
 * **NEW cap**; no existing cap value changed → no human gate.
 */
export const CONTEXT_RESERVE_FRACTION = 0.15;

/**
 * Row-count **safety rail** for the durable-turn model-messages seed
 * (plan #944). Mirrors `MODEL_MSG_CHECKPOINT_MAX_ROWS`; bounds a
 * pathological message *count* (replay/DoS bound) — deliberately NOT the
 * payload-size mechanism (that is the token budget + `MODEL_MSG_SEED_MAX_BYTES`).
 * **NEW generous cap**; no existing cap value changed → no human gate.
 * Enforced in `lib/agent/modelMessages.ts` `trimModelMessagesToBudget`.
 */
export const MODEL_MSG_SEED_MAX_ROWS = 4_096;

/**
 * Serialized-byte ceiling on the trimmed `priorMessages` **Workflow run arg**
 * (plan #944). `priorMessages` is passed as a `start(turnWorkflow, …)` arg
 * (a serialized run input re-carried into the orchestrator), so the seed trim
 * also enforces this ceiling before `start()` — a large-window seed can never
 * bloat the Workflow-arg channel past a bound it tolerates. Set at ~2 MiB to
 * mirror the Function-body bound (`HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES`).
 * **NEW cap**; no existing cap value changed → no human gate. Enforced in
 * `lib/agent/modelMessages.ts` `trimModelMessagesToBudget`.
 */
export const MODEL_MSG_SEED_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Documented fold-time estimator ratio — **chars per token** (plan #944).
 * At the seed/fold boundary there is no provider count for the
 * not-yet-assembled context (a `UsageSummary` is a per-completion count
 * captured after a round, not a pre-send measurement), so the budget trims
 * with `tokens ≈ ceil(chars / 4)` — the conventional English-prose order.
 * Provider token counts (already captured in `usageSummary.ts`) remain the
 * occupancy-meter signal (#556), never this budget's input. **NEW cap**;
 * no existing cap value changed → no human gate. Consumed by
 * `lib/agent/contextBudget.ts` `estimateTokens`.
 */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/**
 * Pi-style completion-reserve **name** for the compaction trigger (plan #948,
 * source #552 — A4 compaction phase 1). Same value as
 * `CONTEXT_RESERVE_MIN_TOKENS` (16 384). `foldBudgetTokens` already subtracts
 * this reserve; `shouldCompact` (`lib/agent/compactionBudget.ts`) compares
 * the pre-trim estimate to that fold budget and must **not** subtract it
 * again (adversarial #953: doing so zeroed the trigger on every ~32k-or-
 * smaller window). Exported so phase 3 / docs can name the Pi default
 * without forking a second literal. **NEW generous cap**; no existing cap
 * value changed → no human gate.
 */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/**
 * Max **chars** of a compaction checkpoint summary (plan #948, source #552).
 * Bounds the persisted summary text the summarizer returns (enforced by
 * `buildCheckpoint` in `lib/agent/compaction.ts` with an explicit marker on
 * overflow — truncate, never drop). Same discipline as
 * `WORKING_NOTES_MAX_BYTES`. **NEW generous cap**; no existing cap value
 * changed → no human gate.
 */
export const COMPACTION_SUMMARY_MAX_CHARS = 8_000;

/**
 * Max number of file paths a compaction checkpoint's `filesTouched` list may
 * carry (plan #948, source #552). Same order as
 * `FRESHNESS_REMINDER_MAX_PATHS` (64), generous for one compaction span;
 * `buildCheckpoint` keeps the NEWEST paths (drop-oldest) with an explicit
 * omitted-count marker. **NEW generous cap**; no existing cap value changed →
 * no human gate.
 */
export const COMPACTION_FILES_TOUCHED_MAX = 256;

/**
 * Byte cap for the persisted compaction checkpoint Blob object (plan #949,
 * source #552 — A4 compaction phase 2). The checkpoint (`{summary,
 * filesTouched, retainedTail}` from #948's `buildCheckpoint`) is its OWN
 * session-bound Blob object — never envelope `meta` (only the ≤512-char
 * pointer id rides `meta` as `compactionPointer`) — so this may exceed the
 * whole-meta budget, mirroring `MODEL_MSG_CHECKPOINT_MAX_BYTES` (8 MiB).
 * Must compose with `MODEL_MSG_SEED_MAX_BYTES` (the Phase-1 `findCompactionCut`
 * tail rail / #944 seed byte rail). A legal cut's `retainedTail` may serialize
 * to that size; the checkpoint JSON adds `summary` (≤8 000 chars + honesty
 * suffixes), `filesTouched` (≤256 paths), and object keys. 256 KiB slack
 * covers that envelope. An oversized write fails closed
 * (`compaction_write_failed`) rather than ever a truncation lie, and the
 * route re-validates + re-pairs on read so only a well-formed checkpoint
 * seeds. Still well under the 8 MiB model-messages object and the 4.5 MB
 * Function wire.
 *
 * **NEW generous cap**; raised on PR #954 (adversarial) from 1 MiB so a
 * Phase-1-legal checkpoint can persist — not a change to an existing-on-main
 * ceiling. No existing cap value changed → **no human gate**. Enforced in
 * `lib/agent/turnPersistSeam.ts` `writeSegment maxBytes`.
 */
export const COMPACTION_CHECKPOINT_MAX_BYTES =
  MODEL_MSG_SEED_MAX_BYTES + 256 * 1024;

/**
 * Max serialized byte size of the compaction SPAN handed to the pre-loop
 * summarizer (plan #950, source #552 — A4 compaction phase 3, parent #947).
 * The span is the rows BEFORE the cut boundary — the text the summarizer
 * reads — and unlike the retained tail it has no phase-1 rail (the tail is
 * bounded by `MODEL_MSG_SEED_MAX_BYTES` inside `findCompactionCut`). Set at
 * ~2 MiB (the same bound class as `MODEL_MSG_SEED_MAX_BYTES` / the Workflow
 * run-arg carrier) so the summarizer prompt stays bounded; a span over the
 * cap is not a yield-to-trim by itself — `findCompactionCut` **continues**
 * to an older user boundary (larger retained tail, shorter span) until a
 * legal cut exists; if growing the tail misses a rail, it **clips** the last
 * fitting tail's span to this ceiling (oldest prefix — parent Goal 1 —
 * not the newest suffix adjacent to the tail; adversarial #955 follow-up
 * 10 restores the follow-up 8 inversion) instead of returning null (plan
 * #950 Caps / adversarial #955 follow-up 5 + 6). Combined `start()` over
 * `COMPACTION_START_MAX_BYTES` prefix-clips the span (adversarial #955
 * follow-up 11) instead of yielding to the #944 trim after a legal cut
 * (the turn is never blocked). **NEW generous cap**; no existing cap
 * value changed → no human gate. Enforced in the cut walk
 * (`lib/agent/compaction.ts` `maxSpanBytes`, passed from
 * `app/api/turns/route.ts`).
 */
export const COMPACTION_SPAN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Combined `start()` compact-args ceiling (adversarial #955 follow-up on
 * PR #955 / plan #950). Prefix-clip `span` + `retainedTail` is oldest
 * overflow + newest tail (middle on neither side). Independently railed
 * they can still compose toward the 4.5 MB Function payload ceiling;
 * `start()` throw → route 503, which compaction must never do (parent
 * forbidden / Goal 6). 3 MiB leaves ~1.5 MB for the SDK envelope + the rest
 * of the `TurnWorkflowArgs`. Over this ceiling the route **prefix-clips
 * the span** (keep tail) until the candidate fits — it does not yield to
 * `#944` after a legal cut (adversarial #955 follow-up 11). Clipped
 * fail-open does not ship a third `failOpenSeed` array (pin+tail
 * reconstructs the newest window). **NEW generous cap**; no existing cap
 * value changed → no human gate.
 * Enforced at the route trigger (`app/api/turns/route.ts`).
 */
export const COMPACTION_START_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Path cap for the per-turn freshness reminder (plan #941, source #693). The
 * reminder names exactly what the #277 `RunFileFreshness` gate will demand
 * (a `read_file` before edit); 64 workspace-relative paths (~4–8 KiB
 * rendered) is generous for one turn's edit surface and keeps the fold a
 * small string — never a second 8 MiB problem. Overflow drops the OLDEST
 * paths (keeps newest — the reads the model is most likely to edit) with an
 * explicit `… (N earlier paths omitted)` marker line. **NEW generous cap**;
 * no existing cap value changed → **no human gate**. Enforced in
 * `lib/agent/freshnessReminder.ts`.
 */
export const FRESHNESS_REMINDER_MAX_PATHS = 64;

/**
 * Byte ceiling on the persisted `{paths}` JSON object (plan #941, source
 * #693) — its own session-bound Blob object, **never** envelope `meta` (only
 * the ≤512-char `freshnessReminderPointer` id rides `meta`). 16 KiB ≫ 64
 * typical paths; bounds a pathological path-length blowup deterministically
 * (trim keeps the newest paths). **NEW generous cap**; no existing cap value
 * changed → **no human gate**. Enforced in `lib/agent/freshnessReminder.ts`
 * + the persist seam's `writeSegment maxBytes`.
 */
export const FRESHNESS_REMINDER_MAX_BYTES = 16 * 1024;

/**
 * Max UTF-8 byte length of a model id carried as the session carrier
 * `meta.selectedModel` (plan #616 / source #610). Single TS source shared by the
 * host trim/parse (`lib/sessionRepository.ts`, `lib/sessionStore.ts`) and server
 * validation (`lib/sessions/sessionStore.ts`, `native/harness` bridge catalog).
 * Mirrors the existing Zig `MAX_MODEL_ID_LEN = 128` catalog-entry bound
 * (`native/harness/src/bridge.zig`) — a NEW TS-side enforcement surface, tabled
 * in plan #616's Caps table as a NEW generous cap (no existing cap value
 * changed; no human gate). Gateway ids (`provider/model`) are short; 128 bytes
 * rides the tiny session envelope far below the 4.5 MB Function ceiling and the
 * 1 MiB whole-meta cap.
 */
export const MAX_MODEL_ID_LEN = 128;

/**
 * Display catalog for the Wasm transcript-rail session list (protocol v17).
 * NEW generous cap — host slices newest-by-updatedAt and always pins current.
 * Not a Redis/list store cap; leftover ids are not painted (not deleted).
 * Must match Zig `MAX_SESSION_CATALOG`.
 */
export const HARNESS_SESSION_RAIL_MAX = 256;

/**
 * UTF-8 byte cap for a rail row label (host-truncated title).
 * NEW — not a `meta.title` store cap. Must match Zig `MAX_SESSION_LABEL_LEN`.
 */
export const HARNESS_SESSION_LABEL_MAX_BYTES = 128;

/**
 * Client-safe predicate for a session-carrier model id (`meta.selectedModel`).
 * Gateway model ids contain `/`, `.`, `:`, `+`, `-` — NOT Redis-safe opaque
 * charset, and the carrier is a meta **value** (never a Redis keyspace segment),
 * so a printable-ASCII ≤ `MAX_MODEL_ID_LEN` bound (mirroring the bridge catalog
 * acceptance) is the correct form. Fail-closed: returns `undefined` for a
 * non-string, empty, over-length, or non-printable-ASCII value (control chars,
 * `\x7f` DEL, or anything outside `\x21`–`\x7e`). Shared by the host trim/parse
 * (drop-to-unset on read, so a poisoned carrier never sticks) and the server
 * validator (which DROPS an invalid `selectedModel` to unset — never a 400 —
 * per plan #616 decision).
 */
export function sanitizeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!s) return undefined;
  if (s.length > MAX_MODEL_ID_LEN) return undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return undefined; // printable ASCII only
  }
  return s;
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

/**
 * Max UTF-8 byte length of a reasoning-effort token (`low`, `provider-default`,
 * Gateway `xhigh`, …). Plan #896 / #897. NEW generous cap — longest SDK token
 * today is `provider-default` (17). Envelope-tiny; ≪ 1 MiB meta / 4.5 MB Function.
 * No existing cap changed.
 */
export const REASONING_EFFORT_MAX_BYTES = 32;

/**
 * Max effort values kept per model from Gateway `reasoning_options`.
 * Plan #896 / #897. NEW generous cap — Gateway lists ≤ 6 today.
 */
export const REASONING_EFFORT_VALUES_MAX = 16;

/**
 * In-process TTL for the unauthenticated Gateway `/v1/models` catalog.
 * Plan #896 / #897. NEW generous cap; best-effort per Function instance.
 */
export const GATEWAY_MODELS_CACHE_TTL_MS = 600_000;

/**
 * Abort a hung Gateway catalog GET so `/api/models` cannot stall a harness boot.
 * Plan #896 / #897. NEW generous cap (5 s). Fail-open to empty options.
 */
export const GATEWAY_MODELS_FETCH_TIMEOUT_MS = 5_000;

/**
 * Max decompressed bytes accepted from `GET https://models.dev/api.json`.
 * Streamed: the reader aborts once the running total exceeds this cap
 * (does not wait to buffer the whole body). Outbound fetch → Function
 * memory (not a Function request body). Live dump ~4.4 MiB (2026-08-31).
 * Oversize fail-opens the overlay.
 */
export const MODELS_DEV_FETCH_MAX_BYTES = 8 * 1024 * 1024;

const REASONING_EFFORT_RE = /^[a-z0-9_-]+$/;

/**
 * AI SDK / Gateway language-model `reasoning` closed enum
 * (`@ai-sdk/provider` LanguageModelV2CallOptions). `max` is **not** in it —
 * models.dev and some Gateway catalogs still list it; sending it 400s
 * (`GatewayInvalidRequestError`). Catalog parse rewrites `max` → `xhigh`
 * then drops remaining non-members; the resolver coerces stored/request
 * `max` to `xhigh` when listed (issue #911 follow-up).
 */
export const GATEWAY_REASONING_WIRE = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type GatewayReasoningWire = (typeof GATEWAY_REASONING_WIRE)[number];

const GATEWAY_REASONING_WIRE_SET: ReadonlySet<string> = new Set(
  GATEWAY_REASONING_WIRE,
);

export function isGatewayReasoningWire(token: string): boolean {
  return GATEWAY_REASONING_WIRE_SET.has(token);
}

/**
 * Adapt a sanitized catalog/request token onto the Gateway wire.
 * The only lab alias is `max` → `xhigh`. Other non-wire tokens drop.
 */
export function adaptEffortToken(token: string): string | undefined {
  const adapted = token === 'max' ? 'xhigh' : token;
  return isGatewayReasoningWire(adapted) ? adapted : undefined;
}

/**
 * Client-safe predicate for a reasoning-effort token (request body, session
 * carrier `meta.reasoningEffort` in phase 2, Gateway values). Trim + lowercase;
 * charset `^[a-z0-9_-]{1,32}$`. Fail-closed → `undefined`.
 */
export function sanitizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  if (!s) return undefined;
  if (s.length > REASONING_EFFORT_MAX_BYTES) return undefined;
  if (!REASONING_EFFORT_RE.test(s)) return undefined;
  return s;
}

/**
 * NEW cap (plan #906): Gateway-resolved inference provider slug. Generous for
 * slugs (`togetherai` 10). Envelope scalar; ≪ 1 MiB meta / 4.5 MB Function.
 * No existing cap changed. Parity-locked to Zig `MAX_RESOLVED_PROVIDER_LEN`.
 */
export const RESOLVED_PROVIDER_MAX_BYTES = 32;

/**
 * Client-safe predicate for a resolved-provider slug (`meta.resolvedProvider`).
 * Canonicalize: trim, reject `/` or `:` (URLs / catalog model ids), lowercase,
 * drop characters outside `[a-z0-9._-]`. Fail-closed → `undefined`.
 * `"Together AI"` → `togetherai`.
 */
export function sanitizeResolvedProvider(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('/') || trimmed.includes(':')) return undefined;
  let out = '';
  for (const ch of trimmed.toLowerCase()) {
    if (
      (ch >= 'a' && ch <= 'z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '.' ||
      ch === '_' ||
      ch === '-'
    ) {
      out += ch;
    }
  }
  if (!out || out.length > RESOLVED_PROVIDER_MAX_BYTES) return undefined;
  return out;
}


