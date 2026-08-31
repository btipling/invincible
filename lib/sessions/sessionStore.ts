/**
 * Phase 1 (#412) — ServerSessionStore seam for the multi-session cloud harness
 * model (parent #411). Server-only; backed by Redis over the RESP protocol
 * (`REDIS_URL`), via `lib/sessions/redisSessionStore.ts`.
 *
 * **Server-only.** Never import this module (or siblings in `lib/sessions`) from
 * client/Wasm code — the Redis client and DB-coupled validation must stay on the
 * Vercel backend. It is wired server-side in Phase 2 (#414).
 *
 * Parent #411 locks absorbed here:
 *  - `meta` is **schema-typed reserved**: only the reserved P1 keys
 *    (`activeSandboxId`, `logicalCwd`, `legacySnapshotId`) plus a serialized size
 *    cap; unknown/oversized keys rejected. No free-form secret-heuristic sniffing.
 *  - `put` **create** preserves a supplied `updatedAt` untouched (a sealed `0`
 *    stays `0`); **upsert** keeps stored `createdAt` and advances `updatedAt` LWW.
 *    The `updatedAt: 0` mint seed is applied by the Phase 2 mint / Phase 4 backfill.
 *
 * Adversarial-review (btipling) fixes folded in this phase:
 *  - **key ↔ record binding** — `put` throws if `key.tenantId/userId/sessionId`
 *    differ from `record.tenantId/userId/id`, closing the confused-deputy footgun.
 *  - **Redis-safe opaque charset** — `tenantId`/`userId`/`id` are restricted to
 *    `[A-Za-z0-9_-]{1,512}` so `KEYS`/prefix globs (`* : ? [ ]`) can never be
 *    smuggled through an id; the `{tenant}:{user}:` list prefix stays unambiguous.
 *  - **upsert enforces stored `createdAt`** at the store, not just by caller discipline.
 *  - **trust-but-verify on read** — `get`/`list` re-validate JSON read from Redis AND
 *    require the blob's own `tenantId`/`userId`/`id` to re-bind to the key it lives
 *    under, so corrupt / mis-ownered blobs fail closed (adversarial re-run Minor L2).
 *  - **Atomic-CAS residual (deferred to #414):** LWW here is check-then-set (read +
 *    conditional write) and is **not** a single atomic op. Phase 1 has no route yet, so
 *    this is a documented seam limitation; the Phase 2 route must fail closed (return the
 *    server copy on conflict) and may upgrade to a Lua / versioned CAS before shipping
 *    multi-device concurrency. Do not treat this store as an atomic compare-and-set.
 */
import {
  HARNESS_SESSION_MAX_ATTACHED_SKILLS,
  HARNESS_SESSION_MAX_META_BYTES,
  PERSONA_SNAPSHOT_MAX_BYTES,
  SKILL_SLUG_RE,
  isRedisSafeOpaqueId,
  sanitizeModelId,
  sanitizeReasoningEffort,
  sanitizeSessionCwd,
  sanitizeTurnRunId,
  sanitizeTurnStatus,
  sanitizeTurnStreamCursor,
} from '../sessionCloudCaps';
export { isRedisSafeOpaqueId } from '../sessionCloudCaps';
import { decodeUsageMetaString } from '../agent/usageSummary';
import { validateSessionSnapshot } from '../tenancy/harnessSessions';
import type { HarnessSessionErrorCode } from '../tenancy/harnessSessions';
import type { SessionMessage } from '../sessionStore';

/**
 * Reserved `meta` keys — the ONLY keys a session record may carry (parent #411).
 * `activeSandboxId` / `logicalCwd` are P1 (GAP-1); `legacySnapshotId` is the
 * Phase 4 backfill trace key; `title` is the optional display title stored by the
 * Phase 2 mint (list summary).
 *
 * **Reserved-meta write contract (going forward, every key):**
 * PUT / `upsertEnvelope` `meta` is the **full desired set** (replace).
 * Absent key = clear that field. The store does **not** merge holes.
 * Mid-turn writers MUST copy existing meta, then override the one key they
 * mean to change. Host `cloudMetaFor` omits a key only when the snapshot
 * field is unset (that omit is a clear). Do not add a new reserved key that
 * treats omit as "keep previous."
 */
export const RESERVED_META_KEYS = [
  'activeSandboxId',
  'logicalCwd',
  'legacySnapshotId',
  'title',
  'personaId',
  'personaSnapshot',
  'transcriptPointer',
  'checkpointPointer',
  'attachedSkills',
  'selectedModel',
  'reasoningEffort',
  'usage',
  'turnRunId',
  'turnStatus',
  'turnStreamCursor',
] as const;
export type HarnessSessionMetaKey = (typeof RESERVED_META_KEYS)[number];

/** Opaque values under reserved `meta` keys (scalars only; no nested structures). */
export type HarnessSessionMeta = {
  [K in HarnessSessionMetaKey]?: string | number | boolean;
};

/** Server-side multi-session record (Redis JSON value). */
export type HarnessSessionRecord = {
  id: string;
  userId: string;
  tenantId: string;
  /** Epoch ms at mint/server-create; immutable after create. */
  createdAt: number;
  /** Epoch ms of last accepted write. New sessions are seeded `0` (never auto-bumped on create). */
  updatedAt: number;
  messages: SessionMessage[];
  meta: HarnessSessionMeta;
};

/** Store addressing — ownership is always the authenticated user within a tenant. */
export type SessionRecordKey = {
  tenantId: string;
  userId: string;
  sessionId: string;
};

/** Listing scope — one user's sessions within a tenant. */
export type SessionListScope = { tenantId: string; userId: string };

export type SessionStoreCode =
  | HarnessSessionErrorCode
  | 'invalid_created_at'
  | 'invalid_tenant'
  | 'invalid_user'
  | 'invalid_key'
  | 'invalid_meta';

export type SessionStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SessionStoreCode; error: string };

/** Outcome of a `put`: written, or rejected because the server has a newer record. */
export type PutResult =
  | { status: 'stored'; record: HarnessSessionRecord }
  | { status: 'conflict'; server: HarnessSessionRecord };

export interface ServerSessionStore {
  get(key: SessionRecordKey): Promise<HarnessSessionRecord | null>;
  put(key: SessionRecordKey, record: HarnessSessionRecord): Promise<PutResult>;
  list(scope: SessionListScope): Promise<HarnessSessionRecord[]>;
  remove(key: SessionRecordKey): Promise<boolean>;
}

/**
 * Phase 0 (#515) — the small, always-fetchable **envelope** (ownership, `updatedAt`
 * LWW, `createdAt`, reserved `meta` incl. the `transcriptPointer`). The transcript
 * (the only large surface) lives in Blob objects pointed to by `meta.transcriptPointer`;
 * the envelope never carries messages. `get`/`put`/`list` remain the **legacy roll-forward**
 * full-record surface (whole-blob records stay readable while they stay small).
 */
export type SessionEnvelope = {
  id: string;
  userId: string;
  tenantId: string;
  createdAt: number;
  updatedAt: number;
  meta: HarnessSessionMeta;
};

/** Envelope upsert input (ownership is always the authed user within a tenant). */
export type SessionEnvelopeInput = {
  id: string;
  userId: string;
  tenantId: string;
  updatedAt: number;
  meta?: HarnessSessionMeta;
};

export type EnvelopeUpsertResult =
  | { status: 'stored'; envelope: SessionEnvelope }
  | { status: 'conflict'; server: SessionEnvelope };

/** Additive phase-0 envelope seam. See `SessionEnvelopeStore`. */
export interface SessionEnvelopeStore extends ServerSessionStore {
  /** Read only the envelope (never the transcript). `null` when absent/roll-forward-only. */
  readEnvelope(key: SessionRecordKey): Promise<SessionEnvelope | null>;
  /**
   * Upsert the envelope (LWW on `updatedAt`, `createdAt` preserved). Never touches
   * transcript. `input.meta` **replaces** stored meta (absent key = clear) —
   * see reserved-meta write contract on `RESERVED_META_KEYS`.
   */
  upsertEnvelope(
    key: SessionRecordKey,
    input: SessionEnvelopeInput,
  ): Promise<EnvelopeUpsertResult>;
}

/** Type guard — a store implementing the phase-0 envelope seam. */
export function isEnvelopeStore(store: ServerSessionStore): store is SessionEnvelopeStore {
  return (
    typeof (store as SessionEnvelopeStore).readEnvelope === 'function' &&
    typeof (store as SessionEnvelopeStore).upsertEnvelope === 'function'
  );
}

/**
 * Redis-safe opaque id predicate lives in the shared client-safe seam
 * (`lib/sessionCloudCaps.ts`) so the same charset rule drives server validation AND
 * host/repository sanitizing without drift. Re-exported here for the server boundary.
 * @see isRedisSafeOpaqueId
 */

/** Redis key for a single record (also the canonical key string for the memory double). */
export function sessionKeyString(key: SessionRecordKey): string {
  return `harness:session:${key.tenantId}:${key.userId}:${key.sessionId}`;
}

/**
 * Reverse of `sessionKeyString`: parse a stored key string back into a
 * `SessionRecordKey`. Returns `null` when the shape is wrong or any segment is not a
 * Redis-safe opaque id (so a malformed / hand-crafted key can never address anything).
 * Used by read paths to re-bind a blob to the key it actually lives under.
 */
export function parseSessionKeyString(key: string): SessionRecordKey | null {
  const parts = key.split(':');
  if (parts.length !== 5) return null;
  if (parts[0] !== 'harness' || parts[1] !== 'session') return null;
  const result = validateSessionRecordKey({
    tenantId: parts[2],
    userId: parts[3],
    sessionId: parts[4],
  });
  return result.ok ? result.value : null;
}

/**
 * Redis list pattern for one user's sessions within a tenant.
 * Safe because every id segment is validated to `[A-Za-z0-9_-]` (never `:` or a glob),
 * so the `{tenant}:{user}:*` prefix can never bleed into another tenant/user/key.
 */
export function sessionPrefix(scope: SessionListScope): string {
  return `harness:session:${scope.tenantId}:${scope.userId}:*`;
}

/**
 * Phase 0 (#515) — Redis key for the **small envelope** of a session
 * (`harness:envelope:{tenant}:{user}:{session}`), a separate namespace from the
 * legacy `harness:session:*` whole-blob keys so legacy roll-forward `get`/`list`/
 * backfill never collide with the envelope carrier. Every segment is Redis-safe
 * opaque, so the prefix glob stays unambiguous (same charset rule as `sessionKeyString`).
 */
export function envelopeKeyString(key: SessionRecordKey): string {
  return `harness:envelope:${key.tenantId}:${key.userId}:${key.sessionId}`;
}

/**
 * Reverse of `envelopeKeyString`: parse a stored envelope key string back into a
 * `SessionRecordKey`. `null` when the shape is wrong or any segment is not Redis-safe
 * (so a malformed / hand-crafted key can never address an envelope).
 */
export function parseEnvelopeKeyString(key: string): SessionRecordKey | null {
  const parts = key.split(':');
  if (parts.length !== 5) return null;
  if (parts[0] !== 'harness' || parts[1] !== 'envelope') return null;
  const result = validateSessionRecordKey({
    tenantId: parts[2],
    userId: parts[3],
    sessionId: parts[4],
  });
  return result.ok ? result.value : null;
}

/** Strip a full record (legacy whole-blob) to its phase-0 envelope (drops messages). */
export function envelopeFromRecord(record: HarnessSessionRecord): SessionEnvelope {
  return {
    id: record.id,
    userId: record.userId,
    tenantId: record.tenantId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    meta: record.meta,
  };
}

/**
 * Idempotent-backfill marker key (parent #411 phase-4 lock). Lives in a **separate
 * namespace** from `harness:session:*`, so a marker is never returned by a
 * `harness:session:{tenant}:{user}:*` list glob nor parsed back into a session key.
 * Marks "this legacy row is migrated" per `{tenant,user}` — distinct from "has any
 * session" (users may legitimately have many/new sessions).
 */
export function backfillMarkerKey(scope: SessionListScope): string {
  return `harness:sessions-backfill:${scope.tenantId}:${scope.userId}:v1`;
}

/**
 * Marker seam for the one-shot Phase-4 backfill (`scripts/backfill-sessions.ts`).
 * Both store implementations implement it so the backfill stays testable with
 * `MemorySessionStore` and runs idempotently against `RedisSessionStore` without
 * constructing I/O in the script body (mandatory DI gate).
 */
export interface BackfillMarkerStore {
  hasBackfillMarker(scope: SessionListScope): Promise<boolean>;
  setBackfillMarker(scope: SessionListScope): Promise<void>;
}

/** Validate a store key (tenant/user/session ids, all Redis-safe opaque). */
export function validateSessionRecordKey(
  input: unknown,
): SessionStoreResult<SessionRecordKey> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_key', error: 'Session key must be an object.' };
  }
  const o = input as Record<string, unknown>;
  if (!isRedisSafeOpaqueId(o.tenantId)) {
    return {
      ok: false,
      code: 'invalid_tenant',
      error: 'tenantId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.userId)) {
    return {
      ok: false,
      code: 'invalid_user',
      error: 'userId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.sessionId)) {
    return {
      ok: false,
      code: 'invalid_id',
      error: 'sessionId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  return {
    ok: true,
    value: { tenantId: o.tenantId, userId: o.userId, sessionId: o.sessionId },
  };
}

export function assertValidSessionRecordKey(key: SessionRecordKey): void {
  const result = validateSessionRecordKey(key);
  if (!result.ok) throw new Error(`Invalid session key: ${result.error}`);
}

/** Validate a list scope (tenant/user only). */
export function validateSessionListScope(
  input: unknown,
): SessionStoreResult<SessionListScope> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_key', error: 'Session list scope must be an object.' };
  }
  const o = input as Record<string, unknown>;
  if (!isRedisSafeOpaqueId(o.tenantId)) {
    return {
      ok: false,
      code: 'invalid_tenant',
      error: 'tenantId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.userId)) {
    return {
      ok: false,
      code: 'invalid_user',
      error: 'userId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  return { ok: true, value: { tenantId: o.tenantId, userId: o.userId } };
}

export function assertValidSessionListScope(scope: SessionListScope): void {
  const result = validateSessionListScope(scope);
  if (!result.ok) throw new Error(`Invalid session list scope: ${result.error}`);
}

/**
 * Does the caller-supplied key match the record identity? Ownership is always the
 * authenticated user within a tenant; this prevents a confused-deputy or buggy caller
 * from storing an attacker-owned record under a victim prefix (adversarial review L2).
 * Used (in throw form) on write and (in boolean form) on read to fail closed.
 */
export function keyMatchesRecord(
  key: SessionRecordKey,
  record: HarnessSessionRecord,
): boolean {
  return (
    key.tenantId === record.tenantId &&
    key.userId === record.userId &&
    key.sessionId === record.id
  );
}

/** Throwing wrapper used on the write boundary (`put`). */
export function assertKeyMatchesRecord(
  key: SessionRecordKey,
  record: HarnessSessionRecord,
): void {
  if (!keyMatchesRecord(key, record)) {
    throw new Error(
      'Session record identity must match the session key (tenantId/userId/id).',
    );
  }
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * `meta` is **schema-typed reserved** (parent #411): only the reserved P1 keys, each
 * value an opaque scalar, with a serialized size cap. Rejects unknown/oversized keys
 * and non-object `meta`. No free-form "secret-looking value" sniffing — the reserved
 * key set + cap is the whole contract (secrets are forbidden by construction + tests).
 */
export function validateMeta(value: unknown): SessionStoreResult<HarnessSessionMeta> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_meta', error: 'meta must be an object.' };
  }
  const raw = value as Record<string, unknown>;
  const meta: HarnessSessionMeta = {};
  for (const key of Object.keys(raw)) {
    if (!(RESERVED_META_KEYS as readonly string[]).includes(key)) {
      return { ok: false, code: 'invalid_meta', error: `meta key '${key}' is not a reserved key.` };
    }
    const v = raw[key];
    // Non-critical UX carriers: poison drops to unset (omit), never 400s the
    // record. PUT meta is a full replace — absent key = clear. Do not copy
    // attachedSkills (that key still fail-closes on malformed JSON).
    if (key === 'selectedModel') {
      const cleaned = sanitizeModelId(v);
      if (cleaned !== undefined) meta.selectedModel = cleaned;
      continue;
    }
    if (key === 'reasoningEffort') {
      const cleaned = sanitizeReasoningEffort(v);
      if (cleaned !== undefined) meta.reasoningEffort = cleaned;
      continue;
    }
    if (key === 'usage') {
      const cleaned = decodeUsageMetaString(v);
      if (cleaned !== undefined) meta.usage = JSON.stringify(cleaned);
      continue;
    }
    if (key === 'turnRunId') {
      // Plan #795 (backend-agents A1): a Workflow run id carrier. Non-critical —
      // a poisoned/oversized/non-opaque value DROPS to unset (omitted), never 400s
      // the record (same drop-to-unset decision as `selectedModel` / `usage`).
      const cleaned = sanitizeTurnRunId(v);
      if (cleaned !== undefined) meta.turnRunId = cleaned;
      continue;
    }
    if (key === 'turnStatus') {
      // Plan #796 (backend-agents A2): a reserved turn-status carrier. Non-critical —
      // a poisoned/unknown/case-folded/oversized value DROPS to unset (omitted), never
      // 400s the record (same drop-to-unset decision as `selectedModel` / `usage` /
      // `turnRunId`). `completed` is a valid first-class terminal member, preserved as-is
      // so the later C15 live-only 409 (#809) can re-allow the next prompt on completion.
      const cleaned = sanitizeTurnStatus(v);
      if (cleaned !== undefined) meta.turnStatus = cleaned;
      continue;
    }
    if (key === 'turnStreamCursor') {
      // Plan #797 (backend-agents A3): a reserved monotonic attach/replay cursor
      // carrier. Non-critical — a poisoned (negative / `NaN` / non-finite /
      // non-integer / over-cap / non-`number`) value DROPS to unset (omitted), never
      // 400s the record (same drop-to-unset decision as `selectedModel` / `usage` /
      // `turnRunId` / `turnStatus`). A distinct reserved key — the cursor is NEVER
      // folded into `turnRunId` (parent Architecture lock).
      const cleaned = sanitizeTurnStreamCursor(v);
      if (cleaned !== undefined) meta.turnStreamCursor = cleaned;
      continue;
    }
    if (key === 'checkpointPointer') {
      // Plan #800 (backend-agents B6): the reserved Blob-checkpoint pointer,
      // a **sibling** of `transcriptPointer` (same Redis-safe opaque rule, but a distinct
      // key — the transcript and the checkpoint are separate Blob surfaces, never folded
      // together). The checkpoint BODY never rides in `meta`; only the object id does.
      // Non-critical — a poisoned/non-opaque value DROPS to unset (omitted), never 400s
      // the record (same drop-to-unset decision as the A1–A3 turn carriers).
      if (isRedisSafeOpaqueId(v)) meta.checkpointPointer = v;
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return {
        ok: false,
        code: 'invalid_meta',
        error: `meta.${key} must be a string, number, or boolean.`,
      };
    }
    meta[key as HarnessSessionMetaKey] = v as string | number | boolean;
  }
  if (utf8ByteLength(JSON.stringify(meta)) > HARNESS_SESSION_MAX_META_BYTES) {
    return {
      ok: false,
      code: 'invalid_meta',
      error: `meta exceeds ${HARNESS_SESSION_MAX_META_BYTES} bytes.`,
    };
  }
  return { ok: true, value: meta };
}

/**
 * P1 (GAP-1, #452) semantic checks for the session-carrier fields stored under the
 * reserved `meta` keys. Pure + testable; the route maps a failure to the existing
 * 400 `INVALID_META`. `..`-style traversal is deliberately NOT rejected at P1 (no
 * known workspace root yet; deferred to GAP-2/#410 + P3/#403).
 *
 * - `logicalCwd`, when present, must be a valid **workspace-relative** string via the
 *   shared `sanitizeSessionCwd` (rejects host-absolute `/`, UNC `\\`, drive `C:`, and
 *   C0/DEL controls); stored normalized (trimmed).
 * - `activeSandboxId`, when present and non-empty, must be Redis-safe opaque
 *   (`^[A-Za-z0-9_-]{1,512}$`); empty/absent = unset.
 */
export function validateMetaFields(
  meta: HarnessSessionMeta,
): SessionStoreResult<HarnessSessionMeta> {
  const out: HarnessSessionMeta = { ...meta };
  if (out.logicalCwd !== undefined) {
    if (typeof out.logicalCwd !== 'string') {
      return {
        ok: false,
        code: 'invalid_meta',
        error: 'meta.logicalCwd must be a string.',
      };
    }
    const cwd = sanitizeSessionCwd(out.logicalCwd);
    if (cwd === undefined) {
      return {
        ok: false,
        code: 'invalid_meta',
        error:
          'meta.logicalCwd must be workspace-relative (not host-absolute / UNC / drive / control chars).',
      };
    }
    out.logicalCwd = cwd;
  }
  if (out.activeSandboxId !== undefined && out.activeSandboxId !== '') {
    if (
      typeof out.activeSandboxId !== 'string' ||
      !isRedisSafeOpaqueId(out.activeSandboxId)
    ) {
      return {
        ok: false,
        code: 'invalid_meta',
        error:
          'meta.activeSandboxId must be empty or a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
      };
    }
  }
  if (out.personaId !== undefined) {
    if (typeof out.personaId !== 'string' || !isRedisSafeOpaqueId(out.personaId)) {
      return {
        ok: false,
        code: 'invalid_meta',
        error:
          'meta.personaId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
      };
    }
  }
  if (out.personaSnapshot !== undefined) {
    if (typeof out.personaSnapshot !== 'string') {
      return {
        ok: false,
        code: 'invalid_meta',
        error: 'meta.personaSnapshot must be a string.',
      };
    }
    if (Buffer.byteLength(out.personaSnapshot, 'utf8') > PERSONA_SNAPSHOT_MAX_BYTES) {
      return {
        ok: false,
        code: 'invalid_meta',
        error: `meta.personaSnapshot exceeds ${PERSONA_SNAPSHOT_MAX_BYTES} bytes.`,
      };
    }
  }
  // Phase 0 (#515): `meta.transcriptPointer` is the Redis-safe opaque key of the
  // latest transcript object in the Blob store (the envelope's pointer). Server-minted,
  // never a secret; the non-empty value must stay Redis-safe opaque so it can never smuggle
  // a glob/`:` or otherwise alias another key.
  if (out.transcriptPointer !== undefined) {
    if (
      typeof out.transcriptPointer !== 'string' ||
      !isRedisSafeOpaqueId(out.transcriptPointer)
    ) {
      return {
        ok: false,
        code: 'invalid_meta',
        error:
          'meta.transcriptPointer must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
      };
    }
  }
  // Phase 1 (#514): `meta.attachedSkills` is a JSON-encoded string of skill slugs
  // (session-sticky attach). The envelope stays scalar-only, so a raw array is
  // REJECTED here (fail closed) — a client must send the serialized string, and
  // the decoded value must be a JSON array of strings, each a VALID skill slug
  // (matches `SKILL_SLUG_RE`, the client-safe single source re-used by
  // `lib/tenancy/userSkills.ts` — layering: sessionStore ↛ userSkills), with a
  // hard count cap (`HARNESS_SESSION_MAX_ATTACHED_SKILLS`). A malformed/foreign
  // slug or an over-long list fails closed. Skills are re-resolved server-side
  // per turn; the body is never snapshotted into `meta`.
  if (out.attachedSkills !== undefined) {
    if (typeof out.attachedSkills !== 'string') {
      return {
        ok: false,
        code: 'invalid_meta',
        error: 'meta.attachedSkills must be a JSON-encoded string of slugs.',
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.attachedSkills);
    } catch {
      return {
        ok: false,
        code: 'invalid_meta',
        error: 'meta.attachedSkills must be a JSON-encoded string of slugs.',
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        code: 'invalid_meta',
        error: 'meta.attachedSkills must decode to a JSON array of slugs.',
      };
    }
    if (parsed.length > HARNESS_SESSION_MAX_ATTACHED_SKILLS) {
      return {
        ok: false,
        code: 'invalid_meta',
        error: `meta.attachedSkills must contain at most ${HARNESS_SESSION_MAX_ATTACHED_SKILLS} slugs.`,
      };
    }
    for (const slug of parsed) {
      if (typeof slug !== 'string' || !SKILL_SLUG_RE.test(slug)) {
        return {
          ok: false,
          code: 'invalid_meta',
          error: 'meta.attachedSkills must decode to a JSON array of valid skill slugs.',
        };
      }
    }
  }
  if (out.usage !== undefined) {
    const cleaned = decodeUsageMetaString(out.usage);
    if (cleaned === undefined) {
      delete out.usage;
    } else {
      out.usage = JSON.stringify(cleaned);
    }
  }
  return { ok: true, value: out };
}

/**
 * Validate a full server record, **reusing** the existing snapshot validator for the
 * id / `updatedAt` / messages caps and adding tenant/user/createdAt/meta checks.
 * Call this before persisting a record (the store seams call `assertValidSessionRecord`).
 */
export function validateSessionRecord(input: unknown): SessionStoreResult<HarnessSessionRecord> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_body', error: 'Record must be a JSON object.' };
  }
  const o = input as Record<string, unknown>;

  // tenantId / userId live in Redis Keyspace segments + a KEYS glob prefix, so they must
  // use the Redis-safe opaque charset (adversarial review L2) — not just "non-empty ≤128".
  if (!isRedisSafeOpaqueId(o.tenantId)) {
    return {
      ok: false,
      code: 'invalid_tenant',
      error: 'tenantId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.userId)) {
    return {
      ok: false,
      code: 'invalid_user',
      error: 'userId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (typeof o.createdAt !== 'number' || !Number.isSafeInteger(o.createdAt) || o.createdAt < 0) {
    return {
      ok: false,
      code: 'invalid_created_at',
      error: 'createdAt must be a non-negative safe integer (epoch ms).',
    };
  }

  // Reuse the existing validator for id / updatedAt / messages (caps + roles + sizes).
  const core = validateSessionSnapshot({
    id: o.id,
    updatedAt: o.updatedAt,
    messages: o.messages,
  });
  if (!core.ok) {
    return { ok: false, code: core.code, error: core.error };
  }

  // `id` also lives inside the key (`...:user:${id}`), so it gets the Redis-safe charset on
  // top of the snapshot's opaque-no-control check — no glob/user-key bleed (adversarial L2).
  if (!isRedisSafeOpaqueId(core.value.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      error: 'id must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }

  const metaResult = validateMeta(o.meta);
  if (!metaResult.ok) return metaResult;

  // P1 (GAP-1, #452): semantic checks + normalization for the session-carrier fields
  // (`logicalCwd`, `activeSandboxId`) under the reserved `meta`.
  const metaFieldsResult = validateMetaFields(metaResult.value);
  if (!metaFieldsResult.ok) return metaFieldsResult;

  return {
    ok: true,
    value: {
      id: core.value.id,
      tenantId: o.tenantId,
      userId: o.userId,
      createdAt: o.createdAt,
      updatedAt: core.value.updatedAt,
      messages: core.value.messages,
      meta: metaFieldsResult.value,
    },
  };
}

/** Throwing wrapper for the store `put` boundary — records are validated before persistence. */
export function assertValidSessionRecord(record: HarnessSessionRecord): void {
  const result = validateSessionRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid session record: ${result.error}`);
  }
}

/**
 * Phase 0 (#515) — validate an **envelope** (never a transcript). Reuses the same
 * reserved-`meta` validator + Redis-safe charset rules, but requires the ownership
 * identity (id/tenantId/userId) and LWW `updatedAt`, and never carries `messages`.
 */
export function validateSessionEnvelope(
  input: unknown,
): SessionStoreResult<SessionEnvelope> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_body', error: 'Envelope must be a JSON object.' };
  }
  const o = input as Record<string, unknown>;
  if (!isRedisSafeOpaqueId(o.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      error: 'id must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.tenantId)) {
    return {
      ok: false,
      code: 'invalid_tenant',
      error: 'tenantId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (!isRedisSafeOpaqueId(o.userId)) {
    return {
      ok: false,
      code: 'invalid_user',
      error: 'userId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    };
  }
  if (
    typeof o.createdAt !== 'number' ||
    !Number.isSafeInteger(o.createdAt) ||
    o.createdAt < 0
  ) {
    return {
      ok: false,
      code: 'invalid_created_at',
      error: 'createdAt must be a non-negative safe integer (epoch ms).',
    };
  }
  if (
    typeof o.updatedAt !== 'number' ||
    !Number.isSafeInteger(o.updatedAt) ||
    o.updatedAt < 0
  ) {
    return {
      ok: false,
      code: 'invalid_updated_at',
      error: 'updatedAt must be a non-negative safe integer (epoch ms).',
    };
  }
  const metaResult = validateMeta(o.meta);
  if (!metaResult.ok) return metaResult;
  const metaFieldsResult = validateMetaFields(metaResult.value);
  if (!metaFieldsResult.ok) return metaFieldsResult;
  return {
    ok: true,
    value: {
      id: o.id,
      userId: o.userId,
      tenantId: o.tenantId,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      meta: metaFieldsResult.value,
    },
  };
}

/** Throwing wrapper for the envelope `upsertEnvelope` boundary. */
export function assertValidSessionEnvelope(envelope: SessionEnvelope): void {
  const result = validateSessionEnvelope(envelope);
  if (!result.ok) {
    throw new Error(`Invalid session envelope: ${result.error}`);
  }
}
