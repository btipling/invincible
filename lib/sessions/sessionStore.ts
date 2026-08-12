/**
 * Phase 1 (#412) — ServerSessionStore seam for the multi-session cloud harness
 * model (parent #411). Server-only; backed by @upstash/redis REST.
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
 */
import {
  HARNESS_SESSION_MAX_META_BYTES,
  HARNESS_SESSION_SNAPSHOT_ID_MAX,
} from '../sessionCloudCaps';
import { validateSessionSnapshot } from '../tenancy/harnessSessions';
import type { HarnessSessionErrorCode } from '../tenancy/harnessSessions';
import type { SessionMessage } from '../sessionStore';

/** Reserved `meta` keys — the ONLY keys a session record may carry (parent #411). */
export const RESERVED_META_KEYS = ['activeSandboxId', 'logicalCwd', 'legacySnapshotId'] as const;
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

/** Redis key for a single record (also the canonical key string for the memory double). */
export function sessionKeyString(key: SessionRecordKey): string {
  return `harness:session:${key.tenantId}:${key.userId}:${key.sessionId}`;
}

/**
 * Redis list pattern for one user's sessions within a tenant.
 * NOTE: ids (tenant/user/session) are server-minted UUID-shaped (no `:`, no `*`),
 * so the `{tenant}:{user}:` prefix is unambiguous.
 */
export function sessionPrefix(scope: SessionListScope): string {
  return `harness:session:${scope.tenantId}:${scope.userId}:*`;
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

function isNonEmptyId(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= max;
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

  if (!isNonEmptyId(o.tenantId, HARNESS_SESSION_SNAPSHOT_ID_MAX)) {
    return { ok: false, code: 'invalid_tenant', error: 'tenantId must be a non-empty string (max 128).' };
  }
  if (!isNonEmptyId(o.userId, HARNESS_SESSION_SNAPSHOT_ID_MAX)) {
    return { ok: false, code: 'invalid_user', error: 'userId must be a non-empty string (max 128).' };
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

  const metaResult = validateMeta(o.meta);
  if (!metaResult.ok) return metaResult;

  return {
    ok: true,
    value: {
      id: core.value.id,
      tenantId: o.tenantId,
      userId: o.userId,
      createdAt: o.createdAt,
      updatedAt: core.value.updatedAt,
      messages: core.value.messages,
      meta: metaResult.value,
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
