/**
 * Cloud multi-device harness session CRUD.
 * Server-only. One row per user; ownership always from session user id.
 * Never log full message bodies at info; never store secrets in messages.
 */
import { eq } from 'drizzle-orm';
import {
  harnessSessions,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import type { SessionMessage, SessionRole, SessionSnapshot } from '../sessionStore';
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
  HARNESS_SESSION_SNAPSHOT_ID_MAX,
} from '../sessionCloudCaps';

export {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
  HARNESS_SESSION_SNAPSHOT_ID_MAX,
};

const SESSION_ROLES = new Set<SessionRole>(['user', 'assistant', 'system', 'error', 'tool_run']);

export type HarnessSessionsDeps = {
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type HarnessSessionErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_body'
  | 'invalid_id'
  | 'invalid_updated_at'
  | 'invalid_messages'
  | 'message_too_large'
  | 'body_too_large'
  | 'unavailable';

export type HarnessSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: HarnessSessionErrorCode; error: string; value?: T };

async function withDb<T>(
  deps: HarnessSessionsDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withConnection(deps, fn);
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isPrintableOpaqueId(id: string): boolean {
  if (!id || id.length > HARNESS_SESSION_SNAPSHOT_ID_MAX) return false;
  // No null bytes / control chars; allow typical sess_… printable ASCII + common unicode.
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function rowToSnapshot(row: {
  snapshotId: string;
  updatedAt: Date;
  messages: unknown;
}): SessionSnapshot {
  const messages = Array.isArray(row.messages)
    ? (row.messages as SessionMessage[])
    : [];
  return {
    id: row.snapshotId,
    updatedAt: row.updatedAt.getTime(),
    messages,
  };
}

/**
 * Validate a client SessionSnapshot for PUT.
 * Caps: 262144 UTF-8 bytes per text (bridge MAX_MSG_LEN), opaque id ≤128.
 * No message-count ceiling — raw body ~2 MiB is enforced on the route.
 */
export function validateSessionSnapshot(
  body: unknown,
): HarnessSessionResult<SessionSnapshot> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', error: 'Request body must be a JSON object.' };
  }
  const o = body as Record<string, unknown>;

  if (typeof o.id !== 'string' || !isPrintableOpaqueId(o.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      error: 'id must be a non-empty opaque string (max 128, no control characters).',
    };
  }

  if (
    typeof o.updatedAt !== 'number' ||
    !Number.isFinite(o.updatedAt) ||
    !Number.isSafeInteger(o.updatedAt) ||
    o.updatedAt < 0
  ) {
    return {
      ok: false,
      code: 'invalid_updated_at',
      error: 'updatedAt must be a non-negative safe integer (epoch ms).',
    };
  }

  if (!Array.isArray(o.messages)) {
    return {
      ok: false,
      code: 'invalid_messages',
      error: 'messages must be an array.',
    };
  }

  const messages: SessionMessage[] = [];
  for (let i = 0; i < o.messages.length; i++) {
    const m = o.messages[i];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      return {
        ok: false,
        code: 'invalid_messages',
        error: `messages[${i}] must be an object.`,
      };
    }
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 128) {
      return {
        ok: false,
        code: 'invalid_messages',
        error: `messages[${i}].id must be a non-empty string.`,
      };
    }
    if (typeof msg.role !== 'string' || !SESSION_ROLES.has(msg.role as SessionRole)) {
      return {
        ok: false,
        code: 'invalid_messages',
        error: `messages[${i}].role must be user|assistant|system|error.`,
      };
    }
    if (typeof msg.text !== 'string') {
      return {
        ok: false,
        code: 'invalid_messages',
        error: `messages[${i}].text must be a string.`,
      };
    }
    if (utf8ByteLength(msg.text) > HARNESS_SESSION_MAX_MSG_BYTES) {
      return {
        ok: false,
        code: 'message_too_large',
        error: `messages[${i}].text exceeds ${HARNESS_SESSION_MAX_MSG_BYTES} UTF-8 bytes.`,
      };
    }
    if (typeof msg.at !== 'number' || !Number.isFinite(msg.at)) {
      return {
        ok: false,
        code: 'invalid_messages',
        error: `messages[${i}].at must be a finite number.`,
      };
    }
    messages.push({
      id: msg.id,
      role: msg.role as SessionRole,
      text: msg.text,
      at: msg.at,
    });
  }

  return {
    ok: true,
    value: {
      id: o.id,
      updatedAt: o.updatedAt,
      messages,
    },
  };
}

export async function getHarnessSession(
  userId: string,
  deps: HarnessSessionsDeps = {},
): Promise<HarnessSessionResult<SessionSnapshot>> {
  const id = userId?.trim();
  if (!id) {
    return { ok: false, code: 'not_found', error: 'Session not found.' };
  }
  try {
    return await withDb(deps, async (db) => {
      const rows = await db
        .select({
          snapshotId: harnessSessions.snapshotId,
          updatedAt: harnessSessions.updatedAt,
          messages: harnessSessions.messages,
        })
        .from(harnessSessions)
        .where(eq(harnessSessions.userId, id))
        .limit(1);
      if (rows.length === 0) {
        return { ok: false, code: 'not_found', error: 'Session not found.' };
      }
      return { ok: true, value: rowToSnapshot(rows[0]) };
    });
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      error: 'Session store temporarily unavailable.',
    };
  }
}

/**
 * Archive (Phase 4): the Postgres `harness_sessions` table is now a **read-only
 * durable archive** after `scripts/backfill-sessions.ts` migrated each row to
 * Redis multi-session. The legacy `/api/session` write route (PUT/DELETE) was
 * removed; only this read path + the shared `validateSessionSnapshot` / caps
 * exports (reused by `lib/sessions/sessionStore.ts`) remain.
 */

/** Factory (DI): binds a fixed deps closure for composition-root wiring (archive read only). */
export function createHarnessSessions(deps: HarnessSessionsDeps = {}) {
  return {
    getHarnessSession: (userId: string, o?: HarnessSessionsDeps) =>
      getHarnessSession(userId, { ...deps, ...o }),
  };
}
