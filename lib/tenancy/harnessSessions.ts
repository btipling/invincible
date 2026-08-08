/**
 * Cloud multi-device harness session CRUD (parent #242 / phase #243).
 * Server-only. One row per user; ownership always from session user id.
 * Never log full message bodies at info; never store secrets in messages.
 */
import { eq } from 'drizzle-orm';
import {
  createDbConnection,
  harnessSessions,
  type Db,
} from '../../db';
import type { SessionMessage, SessionRole, SessionSnapshot } from '../sessionStore';

/** Stable machine code when tenancy is off (API returns 404). */
export const CLOUD_SESSION_DISABLED_CODE = 'CLOUD_SESSION_DISABLED';

export const CLOUD_SESSION_DISABLED_ERROR = 'Cloud session sync is disabled.';

/** Align with bridge MAX_MSG_LEN (UTF-8 bytes). */
export const HARNESS_SESSION_MAX_MSG_BYTES = 4096;

/** Max messages stored per user session row. */
export const HARNESS_SESSION_MAX_MESSAGES = 500;

/** Opaque client SessionSnapshot.id max length. */
export const HARNESS_SESSION_SNAPSHOT_ID_MAX = 128;

/** Reject raw PUT bodies larger than this (~2 MiB). */
export const HARNESS_SESSION_MAX_BODY_BYTES = 2 * 1024 * 1024;

const SESSION_ROLES = new Set<SessionRole>(['user', 'assistant', 'system', 'error']);

export type HarnessSessionsDeps = {
  db?: Db;
};

export type HarnessSessionErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_body'
  | 'invalid_id'
  | 'invalid_updated_at'
  | 'invalid_messages'
  | 'message_too_large'
  | 'too_many_messages'
  | 'body_too_large'
  | 'unavailable';

export type HarnessSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: HarnessSessionErrorCode; error: string; value?: T };

async function withDb<T>(
  deps: HarnessSessionsDeps,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) {
    return fn(deps.db);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required');
  }
  const { db, client } = createDbConnection();
  try {
    return await fn(db);
  } finally {
    await client.end({ timeout: 5 });
  }
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
 * Caps: 500 messages, 4096 UTF-8 bytes per text, opaque id ≤128.
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

  if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) {
    return {
      ok: false,
      code: 'invalid_updated_at',
      error: 'updatedAt must be a finite number (epoch ms).',
    };
  }

  if (!Array.isArray(o.messages)) {
    return {
      ok: false,
      code: 'invalid_messages',
      error: 'messages must be an array.',
    };
  }

  if (o.messages.length > HARNESS_SESSION_MAX_MESSAGES) {
    return {
      ok: false,
      code: 'too_many_messages',
      error: `messages must have at most ${HARNESS_SESSION_MAX_MESSAGES} entries.`,
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
 * LWW upsert: body.updatedAt < serverMs → conflict + server snapshot;
 * body.updatedAt >= serverMs → accept (equal = idempotent overwrite).
 */
export async function putHarnessSession(
  userId: string,
  snapshot: SessionSnapshot,
  deps: HarnessSessionsDeps = {},
): Promise<HarnessSessionResult<SessionSnapshot>> {
  const id = userId?.trim();
  if (!id) {
    return { ok: false, code: 'not_found', error: 'Session not found.' };
  }
  try {
    return await withDb(deps, async (db) => {
      const existing = await db
        .select({
          snapshotId: harnessSessions.snapshotId,
          updatedAt: harnessSessions.updatedAt,
          messages: harnessSessions.messages,
        })
        .from(harnessSessions)
        .where(eq(harnessSessions.userId, id))
        .limit(1);

      if (existing.length > 0) {
        const server = rowToSnapshot(existing[0]);
        if (snapshot.updatedAt < server.updatedAt) {
          return {
            ok: false,
            code: 'conflict',
            error: 'Server has a newer session.',
            value: server,
          };
        }
      }

      const updatedAt = new Date(snapshot.updatedAt);
      await db
        .insert(harnessSessions)
        .values({
          userId: id,
          snapshotId: snapshot.id,
          updatedAt,
          messages: snapshot.messages,
        })
        .onConflictDoUpdate({
          target: harnessSessions.userId,
          set: {
            snapshotId: snapshot.id,
            updatedAt,
            messages: snapshot.messages,
          },
        });

      return {
        ok: true,
        value: {
          id: snapshot.id,
          updatedAt: snapshot.updatedAt,
          messages: snapshot.messages,
        },
      };
    });
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      error: 'Session store temporarily unavailable.',
    };
  }
}

/** Idempotent delete of the user's harness session row. */
export async function deleteHarnessSession(
  userId: string,
  deps: HarnessSessionsDeps = {},
): Promise<HarnessSessionResult<{ deleted: boolean }>> {
  const id = userId?.trim();
  if (!id) {
    return { ok: true, value: { deleted: false } };
  }
  try {
    return await withDb(deps, async (db) => {
      const removed = await db
        .delete(harnessSessions)
        .where(eq(harnessSessions.userId, id))
        .returning({ userId: harnessSessions.userId });
      return { ok: true, value: { deleted: removed.length > 0 } };
    });
  } catch {
    return {
      ok: false,
      code: 'unavailable',
      error: 'Session store temporarily unavailable.',
    };
  }
}
