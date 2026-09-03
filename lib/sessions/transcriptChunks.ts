/**
 * Transcript chunk chain (plan #886).
 *
 * Worker persist writes **this-run** messages plus optional `prev` (the prior
 * object id) and `depth` (1-based chain length ending at that object). Host
 * terminal PUT omits `prev` and `depth` (flatten root). Reconstruct walks
 * `prev` oldest→newest and suffix-merges so a Blob read of the latest worker
 * chunk is not the full session.
 *
 * Client-safe: no db, no `node:crypto`, no Blob store. Callers inject `read`
 * and `isBound`. Mid-turn persist is **head-only** — it must not call
 * reconstruct. Terminal persist (plan #934) reconstructs the bound prior
 * chain so the head `messages` are prior + this-run after a this-run-only
 * overlay (the production wall-cap path). Host GET of a **completed**
 * merged head fail-softs to that head when an ancestor walk fails (the head
 * is self-contained). Mid-turn `running` overlays stay fail-closed.
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
 * 1-based length of the chain ending at `body`. Flatten / one-node (no `prev`)
 * is 1. A worker chunk carries `depth` so persist can refuse a 257th object
 * without walking ancestors (adversarial #889). Missing `depth` on a body that
 * still has `prev` is treated as 2 (at least head + one ancestor).
 */
export function transcriptChunkChainLength(body: unknown): number {
  const prev = transcriptChunkPrev(body);
  if (prev.kind !== 'id') return 1;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const d = (body as { depth: unknown }).depth;
    if (typeof d === 'number' && Number.isInteger(d) && d >= 1) {
      return Math.min(d, TRANSCRIPT_CHUNK_WALK_MAX);
    }
  }
  return 2;
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

/** Flatten reconstructed rows onto a snapshot-shaped body (no `prev` / `depth`). */
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
  delete rec.depth;
  rec.id = sessionId;
  rec.messages = messages;
  if (typeof rec.updatedAt !== 'number' || !Number.isFinite(rec.updatedAt)) {
    rec.updatedAt = 0;
  }
  return rec;
}

/**
 * Plan #934 / adversarial #935: after a reconstruct walk, pick the blob GET
 * should parse.
 *
 * - Walk ok → flatten the merged chain (existing #886 path).
 * - Walk fail + live (`running` / `cancelling`) overlay → `null` (fail-closed;
 *   the head is this-run-only; never this-chunk-only).
 * - Walk fail + terminal / unset status → flatten the **head's own messages**
 *   when they parse. The #934 terminal head already carries prior + this-run;
 *   an ancestor 5xx must not throw that complete head away.
 */
export function blobAfterReconstructWalk(input: {
  sessionId: string;
  headBody: unknown;
  walked: ReconstructChainResult;
  turnStatus?: string;
}): Record<string, unknown> | null {
  if (input.walked.ok) {
    return flattenReconstructedBody(
      input.headBody,
      input.sessionId,
      input.walked.messages,
    );
  }
  const live =
    input.turnStatus === 'running' || input.turnStatus === 'cancelling';
  if (live) return null;
  const headMsgs = snapshotMessagesFromUnknown(input.headBody, input.sessionId);
  if (headMsgs === null) return null;
  return flattenReconstructedBody(input.headBody, input.sessionId, headMsgs);
}
