/**
 * backend-agents B8 — envelope `meta` overlay PATCH (worker keys never clobber host).
 *
 * This is the **worker server-side PATCH** for envelope `meta`, and it is
 * deliberately DISTINCT from the host PUT/GET overlay `overlayEnvelopeMeta`
 * (lib/sessionRepository.ts). The two implement opposite reserved-meta contracts:
 *
 * - `overlayEnvelopeMeta` (PUT/GET) — "last full desired set": a valid envelope
 *   value wins, **absent/poison clears** the field.
 * - `overlayWorkerMeta` (this module, PATCH) — "copy-forward": read the current
 *   envelope `meta`, **copy it**, then override ONLY the worker-owned keys the
 *   caller provides; an **absent sibling worker key (or any host key) is kept**,
 *   never cleared.
 *
 * Worker-owned keys (the only keys this PATCH may override):
 * `logicalCwd` / `activeSandboxId` / `usage` / `attachedSkills` / `turnRunId` /
 * `turnStatus` / `turnStreamCursor` / `checkpointPointer` / `modelMessagesPointer` /
 * `resolvedProvider` / `workingNotes` (plan #938 — the working-notes tools write
 * the block best-effort at tool-execute; mid-turn notes survive a cancelled /
 * wall-clocked / errored turn the same commitment as `change_dir`). All host keys
 * (`personaId`, `personaSnapshot`, `title`, `selectedModel`, `legacySnapshotId`,
 * `transcriptPointer`, `reasoningEffort`) are preserved byte-for-byte — a worker PATCH can never
 * clobber a host value.
 *
 * **Never write `turnRunId: sessionId`.** A worker PATCH value for `turnRunId`
 * is a real Workflow run id, validated through `sanitizeTurnRunId`, and a
 * session-id-shaped attempt (cleaned value equal to the scope's `sessionId`)
 * is **skipped, not applied** — the previously stored real run id (if any) is
 * kept, and the key drops to unset only when there was none. A session-id-shaped
 * PATCH must never clear a valid run id (C15's live lock depends on it).
 *
 * Every worker value is sanitized through the shared A1–A3 / reserved-meta
 * predicates (drop-to-unset on poison — never a clear of a sibling, never a 400).
 *
 * LWW discipline mirrors B7 `persistTranscriptSegment`: `readEnvelope` → apply the
 * copy-forward PATCH → `upsertEnvelope` ONLY when the caller's `updatedAt` is
 * strictly newer than the stored envelope's (a stale OR equal `updatedAt` returns
 * a conflict and writes nothing — no silent clobber, no regress). Never throws.
 *
 * Layer: server-side `lib/*` only — no DOM, no Wasm, no Vercel route. Reaches
 * `lib/sessions/*` exclusively through the injected `ServerSessionStore` envelope
 * seam and constructs no I/O in its own body (di-gate).
 */
import {
  isRedisSafeOpaqueId,
  normalizeSessionCwd,
  parseAttachedSkills,
  sanitizeResolvedProvider,
  sanitizeTurnRunId,
  sanitizeTurnStatus,
  sanitizeTurnStreamCursor,
  sanitizeWorkingNotes,
  serializeAttachedSkills,
} from '../sessionCloudCaps';
import { encodeUsageMetaString } from './usageSummary';
import {
  isEnvelopeStore,
  type HarnessSessionMeta,
  type ServerSessionStore,
  type SessionRecordKey,
  type SessionEnvelopeInput,
} from '../sessions/sessionStore';

/** Worker-owned reserved `meta` keys this PATCH may override. Host keys are excluded. */
export const WORKER_META_KEYS = [
  'logicalCwd',
  'activeSandboxId',
  'usage',
  'attachedSkills',
  'turnRunId',
  'turnStatus',
  'turnStreamCursor',
  'checkpointPointer',
  'modelMessagesPointer',
  'resolvedProvider',
  'workingNotes',
] as const;
export type WorkerMetaKey = (typeof WORKER_META_KEYS)[number];

/** A worker overlay PATCH: any subset of the worker-owned meta keys (raw values). */
export type WorkerMetaPatch = Partial<Record<WorkerMetaKey, unknown>>;

export type OverlayWorkerMetaInput = {
  envelopeStore: ServerSessionStore;
  key: SessionRecordKey;
  patch: WorkerMetaPatch;
  /** The worker's authored envelope clock; MUST be strictly newer than the stored
   *  envelope's `updatedAt` (or no envelope yet) or the PATCH is a conflict. */
  updatedAt: number;
};

export type OverlayWorkerMetaResult =
  | { ok: true; meta: HarnessSessionMeta }
  | {
      ok: false;
      code: 'not_envelope_store' | 'invalid_scope' | 'read_failed' | 'lww_conflict';
      error: string;
    };

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Sanitize ONE worker-owned key value through its shared A1–A3 / reserved-meta
 *  predicate. Returns `undefined` (poison) so the caller drops that key to unset
 *  WITHOUT clearing any sibling or host key. `undefined` on a key the caller left
 *  un-set is skipped entirely (never touched) by the copy-forward loop above. */
function sanitizeWorkerKeyValue(key: WorkerMetaKey, value: unknown): string | number | undefined {
  switch (key) {
    case 'logicalCwd':
      return normalizeSessionCwd(value);
    case 'activeSandboxId':
      return typeof value === 'string' && value !== '' && isRedisSafeOpaqueId(value)
        ? value
        : undefined;
    case 'usage':
      // A worker provides a UsageSummary object; the reserved `meta.usage` surface
      // is its JSON-string form (`encodeUsageMetaString` sanitizes + bounds it).
      return encodeUsageMetaString(value);
    case 'attachedSkills':
      if (!Array.isArray(value)) return undefined;
      // Keep only valid, de-duplicated slugs; `[]` = explicit detach-all value.
      return serializeAttachedSkills(parseAttachedSkills(JSON.stringify(value)));
    case 'turnRunId':
      return sanitizeTurnRunId(value);
    case 'turnStatus':
      return sanitizeTurnStatus(value);
    case 'turnStreamCursor':
      return sanitizeTurnStreamCursor(value);
    case 'checkpointPointer':
      // Redis-safe opaque sibling of `transcriptPointer`; the checkpoint BODY
      // never rides in `meta` — only the object id.
      return typeof value === 'string' && value !== '' && isRedisSafeOpaqueId(value)
        ? value
        : undefined;
    case 'modelMessagesPointer':
      // Redis-safe opaque sibling of `checkpointPointer` (plan #936); the
      // model-messages BODY never rides in `meta` — only the object id.
      return typeof value === 'string' && value !== '' && isRedisSafeOpaqueId(value)
        ? value
        : undefined;
    case 'resolvedProvider':
      return sanitizeResolvedProvider(value);
    case 'workingNotes':
      // Plan #938: the session-owned agent working-notes block. Length-only
      // freeform text (32 KiB cap); poison → unset. The tool layer REJECTS an
      // over-cap write before calling the overlay, so an `undefined` here only
      // ever comes from a read-side poison drop (an explicit empty string also
      // clears — `update('')` is the clear verb).
      return sanitizeWorkingNotes(value);
  }
}

/**
 * Pure copy-forward: apply a worker overlay PATCH to the current envelope `meta`.
 * Copies the existing meta, then overrides ONLY worker-owned keys the patch
 * provides (a poison value drops THAT key to unset). All host keys and every
 * worker key ABSENT from the patch are preserved byte-for-byte. Never throws.
 */
export function patchWorkerMeta(
  current: HarnessSessionMeta | undefined,
  patch: WorkerMetaPatch | undefined,
): HarnessSessionMeta {
  const out: HarnessSessionMeta = { ...(current ?? {}) };
  if (!patch) return out;
  for (const key of WORKER_META_KEYS) {
    if (!(key in patch)) continue; // absent worker key → keep previous, never clear
    const cleaned = sanitizeWorkerKeyValue(key, (patch as Record<string, unknown>)[key]);
    if (cleaned !== undefined) {
      out[key] = cleaned;
    } else {
      delete out[key]; // poison → drop THIS worker key to unset; siblings/host untouched
    }
  }
  return out;
}

/**
 * Copy-forward overlay PATCH for envelope `meta` with an LWW write guard.
 * Reads the envelope, applies the copy-forward PATCH, and upserts ONLY when the
 * caller's `updatedAt` is strictly newer than the stored envelope's (or there is
 * no envelope yet). A stale or equal `updatedAt` → `{ ok:false, code:'lww_conflict' }`
 * with nothing written (no silent clobber, no regress). Never throws: every
 * failure path returns `{ ok:false }`. A `turnRunId` value equal to the scope's
 * `sessionId` is additionally SKIPPED (never applied), keeping the previous real
 * run id; it drops to unset only when there was none.
 */
export async function overlayWorkerMeta(
  input: OverlayWorkerMetaInput,
): Promise<OverlayWorkerMetaResult> {
  if (!input?.envelopeStore) {
    return {
      ok: false,
      code: 'not_envelope_store',
      error: 'overlayWorkerMeta requires an envelope store.',
    };
  }
  if (!isEnvelopeStore(input.envelopeStore)) {
    return {
      ok: false,
      code: 'not_envelope_store',
      error:
        'envelope store must implement the phase-0 envelope seam (readEnvelope/upsertEnvelope).',
    };
  }
  const { tenantId, userId, sessionId } = input.key ?? {};
  if (
    typeof tenantId !== 'string' ||
    typeof userId !== 'string' ||
    typeof sessionId !== 'string'
  ) {
    return { ok: false, code: 'invalid_scope', error: 'overlayWorkerMeta requires a session scope.' };
  }
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) {
    return { ok: false, code: 'lww_conflict', error: 'overlayWorkerMeta requires a finite updatedAt.' };
  }

  let envelope;
  try {
    envelope = await input.envelopeStore.readEnvelope(input.key);
  } catch (err) {
    return {
      ok: false,
      code: 'read_failed',
      error: `failed to read the envelope for a worker PATCH: ${toMessage(err)}`,
    };
  }

  // LWW: only a strictly-newer worker clock may advance the envelope. A stale OR
  // equal `updatedAt` is a conflict — nothing is written (no-regress, no clobber).
  if (envelope && input.updatedAt <= envelope.updatedAt) {
    return {
      ok: false,
      code: 'lww_conflict',
      error: 'worker PATCH updatedAt <= stored envelope updatedAt (LWW no-regress).',
    };
  }

  // Copy-forward, then override only worker-owned keys. Host keys always survive.
  const meta = patchWorkerMeta(envelope?.meta, input.patch);
  // Never write `turnRunId: sessionId`: a session-id-shaped PATCH value is
  // SKIPPED (costs the override), keeping the previously stored real run id —
  // a session-id attempt must never clear a valid run id. When there is no
  // previous run id, the key drops to unset.
  if (meta.turnRunId === sessionId) {
    const prev = envelope?.meta?.turnRunId;
    if (prev === undefined) {
      delete meta.turnRunId;
    } else {
      meta.turnRunId = prev; // restore the previously stored real run id
    }
  }

  const envInput: SessionEnvelopeInput = {
    id: sessionId,
    userId,
    tenantId,
    updatedAt: input.updatedAt,
    meta,
  };
  try {
    const res = await input.envelopeStore.upsertEnvelope(input.key, envInput);
    if (res.status !== 'stored') {
      return {
        ok: false,
        code: 'lww_conflict',
        error: 'envelope upsert conflicted on LWW (worker PATCH not applied).',
      };
    }
    // Return the patched meta only — the envelope body/messages never come back.
    return { ok: true, meta: res.envelope.meta };
  } catch (err) {
    return {
      ok: false,
      code: 'lww_conflict',
      error: `worker PATCH write failed on LWW: ${toMessage(err)}`,
    };
  }
}
