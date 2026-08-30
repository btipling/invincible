/**
 * Transcript chunk chain (plan #886).
 *
 * Worker persist writes **this-run** messages plus optional `prev` (the prior
 * object id). Host terminal PUT omits `prev` (flatten root). Reconstruct walks
 * `prev` oldest→newest and suffix-merges so a Blob read of the latest worker
 * chunk is not the full session.
 *
 * Client-safe: no db, no `node:crypto`, no Blob store. Callers inject `read`
 * and `isBound`.
 */
import { TRANSCRIPT_CHUNK_WALK_MAX, isRedisSafeOpaqueId } from '../sessionCloudCaps';
import {
  mergeCheckpointOntoPrior,
  snapshotMessagesFromUnknown,
  type CheckpointSnapshotMessage,
} from '../agent/messageCheckpoint';

export type TranscriptChunkRead = (objectId: string) => Promise<unknown | null>;

export type ReconstructChainResult =
  | { ok: true; messages: CheckpointSnapshotMessage[] }
  | {
      ok: false;
      code: 'missing' | 'unreadable' | 'foreign_prev' | 'loop' | 'walk_cap';
      error: string;
    };

export type ChunkPrev =
  | { kind: 'none' }
  | { kind: 'id'; id: string }
  | { kind: 'invalid' };

/** `prev` on a chunk body: omitted/null = one-node; non-opaque string = invalid. */
export function transcriptChunkPrev(body: unknown): ChunkPrev {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid' };
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'prev')) return { kind: 'none' };
  const prev = (body as { prev: unknown }).prev;
  if (prev === undefined || prev === null) return { kind: 'none' };
  if (typeof prev !== 'string' || !isRedisSafeOpaqueId(prev)) return { kind: 'invalid' };
  return { kind: 'id', id: prev };
}

/**
 * Walk `prev` from `headBody` (already read) and suffix-merge messages
 * oldest-first. Fail-closed on missing / unreadable / foreign / loop / cap —
 * never silently this-chunk-only.
 */
export async function reconstructTranscriptChain(input: {
  sessionId: string;
  headId: string;
  headBody: unknown;
  read: TranscriptChunkRead;
  isBound: (objectId: string) => boolean;
  maxWalk?: number;
}): Promise<ReconstructChainResult> {
  const maxWalk = input.maxWalk ?? TRANSCRIPT_CHUNK_WALK_MAX;
  const headMsgs = snapshotMessagesFromUnknown(input.headBody, input.sessionId);
  if (headMsgs === null) {
    return {
      ok: false,
      code: 'unreadable',
      error: 'transcript chunk is not a session snapshot.',
    };
  }
  if (!input.isBound(input.headId)) {
    return {
      ok: false,
      code: 'foreign_prev',
      error: 'transcript head id is not bound to this session.',
    };
  }

  const newestFirst: CheckpointSnapshotMessage[][] = [headMsgs];
  const seen = new Set<string>([input.headId]);
  let current: unknown = input.headBody;
  let visited = 1;

  for (;;) {
    const prev = transcriptChunkPrev(current);
    if (prev.kind === 'none') break;
    if (prev.kind === 'invalid') {
      return {
        ok: false,
        code: 'unreadable',
        error: 'transcript chunk prev is not a Redis-safe object id.',
      };
    }
    if (!input.isBound(prev.id)) {
      return {
        ok: false,
        code: 'foreign_prev',
        error: 'transcript chunk prev is not bound to this session.',
      };
    }
    if (seen.has(prev.id)) {
      return {
        ok: false,
        code: 'loop',
        error: 'transcript chunk prev walk detected a cycle.',
      };
    }
    if (visited >= maxWalk) {
      return {
        ok: false,
        code: 'walk_cap',
        error: `transcript chunk prev walk exceeded ${maxWalk} objects.`,
      };
    }
    let raw: unknown | null;
    try {
      raw = await input.read(prev.id);
    } catch {
      return {
        ok: false,
        code: 'unreadable',
        error: 'transcript chunk prev read failed.',
      };
    }
    if (raw === null) {
      return {
        ok: false,
        code: 'missing',
        error:
          'bound transcript prev object is missing — refusing this-chunk-only reconstruct.',
      };
    }
    const msgs = snapshotMessagesFromUnknown(raw, input.sessionId);
    if (msgs === null) {
      return {
        ok: false,
        code: 'unreadable',
        error: 'transcript chunk prev body is not a session snapshot.',
      };
    }
    seen.add(prev.id);
    newestFirst.push(msgs);
    current = raw;
    visited += 1;
  }

  let acc: CheckpointSnapshotMessage[] = [];
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const chunk = newestFirst[i];
    if (!chunk) continue;
    acc = mergeCheckpointOntoPrior(acc, chunk);
  }
  return { ok: true, messages: acc };
}

/** Read the pointer object, then walk `prev`. */
export async function reconstructFromPointer(input: {
  pointer: string;
  sessionId: string;
  readRaw: (objectId: string) => Promise<string | null>;
  isBound: (objectId: string) => boolean;
  maxWalk?: number;
}): Promise<ReconstructChainResult> {
  if (!input.isBound(input.pointer)) {
    return {
      ok: false,
      code: 'foreign_prev',
      error: 'transcriptPointer is not bound to this session.',
    };
  }
  let raw: string | null;
  try {
    raw = await input.readRaw(input.pointer);
  } catch {
    return {
      ok: false,
      code: 'unreadable',
      error: 'bound transcriptPointer read failed.',
    };
  }
  if (raw === null) {
    return {
      ok: false,
      code: 'missing',
      error:
        'bound transcriptPointer object is missing — refusing this-run-only replace.',
    };
  }
  let headBody: unknown;
  try {
    headBody = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: 'unreadable',
      error:
        'bound transcriptPointer body is not JSON — refusing this-run-only replace.',
    };
  }
  return reconstructTranscriptChain({
    sessionId: input.sessionId,
    headId: input.pointer,
    headBody,
    read: async (objectId) => {
      const body = await input.readRaw(objectId);
      if (body === null) return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },
    isBound: input.isBound,
    maxWalk: input.maxWalk,
  });
}

/** Flatten reconstructed rows onto a snapshot-shaped body (no `prev`). */
export function flattenReconstructedBody(
  headBody: unknown,
  sessionId: string,
  messages: CheckpointSnapshotMessage[],
): Record<string, unknown> {
  const rec =
    headBody !== null && typeof headBody === 'object' && !Array.isArray(headBody)
      ? { ...(headBody as Record<string, unknown>) }
      : {};
  delete rec.prev;
  rec.id = sessionId;
  rec.messages = messages;
  if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) {
    rec.updatedAt = 0;
  }
  return rec;
}
