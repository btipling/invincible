/**
 * Built-in meta tool family — first-party WORKING-NOTES tools (plan #938,
 * source #550 — backend-agents A2 "agent memory: durable working notes").
 *
 * Three always-on in-process AI-SDK tools bound to the ROUTE-resolved
 * `userId` / `sessionId` (any identity a model passes is ignored — the same
 * confused-deputy guard as `meta_sandbox_switch`):
 *
 *  - `working_notes_get`    — the current session notes block (bounded at
 *    `WORKING_NOTES_MAX_BYTES` = 32 KiB) or an honest `(empty)` / `(unavailable)`
 *    line. Read path: the session envelope `meta.workingNotes` via the same
 *    injected `sessionStoreSeam` as the sandbox bind tools. Never returns
 *    secrets — the block is agent-authored working text.
 *  - `working_notes_update` — args `{ notes }`. Bounded: trim → UTF-8 byte
 *    length ≤ 32 KiB or an explicit error (NEVER truncates). Persists
 *    best-effort at tool-execute via the worker-owned copy-forward envelope
 *    PATCH (`overlayWorkerMeta`, LWW-guarded, one bounded retry on a
 *    concurrent host-bumped clock — mirrors `retryPersistActiveSandbox`), so a
 *    cancelled / wall-clocked / errored turn still keeps the finding. An empty
 *    string clears. Honest on store failure: the turn still succeeds, but the
 *    tool never claims a persistence that did not happen.
 *  - `working_notes_clear`  — clears the block (`update('')` semantics).
 *
 * These tools are the ONLY writers of `meta.workingNotes` — no auto-extraction,
 * no transcript summarization (source #550 honesty bar: the agency to persist
 * belongs to the agent). The notes block is folded into every future turn's
 * system prompt by `resolveSystem` (framed as unverified agent-authored working
 * memory — never "established fact", never standing orders).
 *
 * Layering: pure server-side tool wiring, no I/O construction (di-gate) — the
 * store/seam are injected closures. No secrets surface.
 */
import { jsonSchema, tool } from 'ai';
import {
  WORKING_NOTES_MAX_BYTES,
  sanitizeWorkingNotes,
} from '../sessionCloudCaps';
import {
  isEnvelopeStore,
  type ServerSessionStore,
  type SessionEnvelope,
  type SessionEnvelopeStore,
  type SessionRecordKey,
} from '../sessions/sessionStore';
import type { WorkerMetaPatch } from './workerMetaOverlay';

export type MetaStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

/**
 * Session-store seam closed over by the caller (route / durable scope):
 * `resolveSessionStore()` + `resolveTenantIdForUser` so this module never
 * constructs a store or resolves membership itself (same seam shape as
 * `metaSandboxTools`).
 */
export type SessionStoreSeam = {
  resolveSessionStore(): Promise<MetaStoreResult<ServerSessionStore>>;
  resolveTenantIdForUser(userId: string): Promise<MetaStoreResult<string>>;
};

/**
 * The worker-overlay writer injected by the caller. The tool closes over the
 * function (never imports the module graph into a step-file cycle); the durable
 * caller passes `overlayWorkerMeta` directly. Kept injectable so tests can
 * stub the persist and the di-gate sees no I/O construction here.
 */
export type WorkingNotesOverlayWriter = (input: {
  envelopeStore: SessionEnvelopeStore;
  key: SessionRecordKey;
  patch: WorkerMetaPatch;
  updatedAt: number;
}) => Promise<{ ok: boolean; code?: string; error?: string }>;

export type CreateWorkingNotesToolsOptions = {
  userId: string;
  /** Caller-owned session id (Redis-safe opaque); absent → honest unavailability. */
  sessionId?: string;
  sessionStoreSeam: SessionStoreSeam;
  /** Worker-overlay writer (defaults to `overlayWorkerMeta` at assembly time). */
  overlayWorkerMeta?: WorkingNotesOverlayWriter;
};

/** Reserved first-party prefix that marks this family (route soft-path guard). */
export const WORKING_NOTES_TOOL_PREFIX = 'working_notes_';

/** True for any first-party working-notes tool name (route soft-path guard). */
export function isWorkingNotesToolName(name: string): boolean {
  return (
    typeof name === 'string' && name.startsWith(WORKING_NOTES_TOOL_PREFIX)
  );
}

/** Read the notes block off the caller's session envelope (fail-soft). */
async function readPersistedNotes(
  opts: CreateWorkingNotesToolsOptions,
): Promise<{ notes: string | undefined; storeAvailable: boolean }> {
  const { userId, sessionId, sessionStoreSeam } = opts;
  if (!sessionId) return { notes: undefined, storeAvailable: false };
  try {
    const tenantRes = await sessionStoreSeam.resolveTenantIdForUser(userId);
    if (!tenantRes.ok) return { notes: undefined, storeAvailable: false };
    const storeRes = await sessionStoreSeam.resolveSessionStore();
    if (!storeRes.ok) return { notes: undefined, storeAvailable: false };
    const store = storeRes.value;
    if (!isEnvelopeStore(store)) return { notes: undefined, storeAvailable: false };
    const key: SessionRecordKey = { tenantId: tenantRes.value, userId, sessionId };
    const envelope = await store.readEnvelope(key);
    const notes = sanitizeWorkingNotes(envelope?.meta?.workingNotes);
    return { notes, storeAvailable: true };
  } catch {
    return { notes: undefined, storeAvailable: false };
  }
}

/**
 * Persist the notes block best-effort via the worker-owned copy-forward
 * overlay PATCH. One bounded retry on an LWW conflict (a concurrent write
 * advanced the stored clock between our read and write — same discipline as
 * `retryPersistActiveSandbox`). Returns true ONLY for a stored write.
 *
 * Clock discipline: `overlayWorkerMeta` writes only on a STRICTLY newer clock,
 * so the tool always advances: `max(stored, wall) + 1` (a notes write is a real
 * envelope write — never a no-op at an equal timestamp).
 */
async function persistNotesPatch(
  store: SessionEnvelopeStore,
  overlay: WorkingNotesOverlayWriter,
  key: SessionRecordKey,
  envelope: SessionEnvelope | null,
  patch: WorkerMetaPatch,
): Promise<boolean> {
  const first = await overlay({
    envelopeStore: store,
    key,
    patch,
    updatedAt: Math.max(envelope?.updatedAt ?? 0, Date.now()) + 1,
  });
  if (first.ok) return true;
  // One bounded retry with the live stored clock (a concurrent write advanced
  // it between our read and the first attempt).
  let live: SessionEnvelope | null = null;
  try {
    live = await store.readEnvelope(key);
  } catch {
    return false;
  }
  const retried = await overlay({
    envelopeStore: store,
    key,
    patch,
    updatedAt: Math.max(live?.updatedAt ?? 0, Date.now()) + 1,
  });
  return retried.ok;
}

function errText(name: string, err: unknown): string {
  return `ERROR ${name}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Resolve (tenant, envelope store) for a write, or an honest error string. */
async function resolveEnvelopeStore(
  opts: CreateWorkingNotesToolsOptions,
): Promise<
  | { ok: true; store: SessionEnvelopeStore; key: SessionRecordKey; envelope: SessionEnvelope | null }
  | { ok: false; error: string }
> {
  const { userId, sessionId, sessionStoreSeam } = opts;
  if (!sessionId) {
    return {
      ok: false,
      error:
        'no sessionId on the request — working notes persist to the session envelope (no write)',
    };
  }
  try {
    const tenantRes = await sessionStoreSeam.resolveTenantIdForUser(userId);
    if (!tenantRes.ok) {
      return {
        ok: false,
        error: 'cannot resolve tenant (session store unavailable?) — notes not persisted',
      };
    }
    const storeRes = await sessionStoreSeam.resolveSessionStore();
    if (!storeRes.ok) {
      return {
        ok: false,
        error: 'session store unavailable — notes not persisted (no partial write)',
      };
    }
    const store = storeRes.value;
    if (!isEnvelopeStore(store)) {
      return {
        ok: false,
        error:
          'session store does not support the envelope seam — notes not persisted (no partial write)',
      };
    }
    const key: SessionRecordKey = { tenantId: tenantRes.value, userId, sessionId };
    let envelope: SessionEnvelope | null = null;
    try {
      envelope = await store.readEnvelope(key);
    } catch {
      envelope = null;
    }
    return { ok: true, store, key, envelope };
  } catch (err) {
    return { ok: false, error: errText('working_notes', err) };
  }
}

/**
 * Lazy default overlay writer — a thin import-bound wrapper over
 * `overlayWorkerMeta` (`lib/agent/workerMetaOverlay.ts`). Kept behind a
 * function indirection so this module's static imports stay free of the
 * overlay module when tests inject a stub (same lazy-import pattern
 * `modelGenerateStep` uses for its preamble resolvers).
 */
async function defaultOverlayWriter(input: {
  envelopeStore: SessionEnvelopeStore;
  key: SessionRecordKey;
  patch: WorkerMetaPatch;
  updatedAt: number;
}): Promise<{ ok: boolean; code?: string; error?: string }> {
  const { overlayWorkerMeta } = await import('./workerMetaOverlay');
  return overlayWorkerMeta(input);
}

export function createWorkingNotesTools(opts: CreateWorkingNotesToolsOptions) {
  const overlayWriter: WorkingNotesOverlayWriter =
    opts.overlayWorkerMeta ?? defaultOverlayWriter;

  const workingNotesGet = tool({
    description:
      "Read the session's agent-authored working-notes block (the persisted meta.workingNotes on this session's envelope — findings/decisions written by you in earlier turns of this session). Returns the bounded block text, or `(empty — no working notes for this session)` when unset. Never contains secrets.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const { notes, storeAvailable } = await readPersistedNotes(opts);
        if (!storeAvailable) {
          return '(unavailable — session store not reachable; notes cannot be read right now)';
        }
        return notes ?? '(empty — no working notes for this session)';
      } catch (err) {
        return errText('working_notes_get', err);
      }
    },
  });

  const workingNotesUpdate = tool({
    description:
      "Persist the session's agent-authored working-notes block: replaces meta.workingNotes on this session's envelope with `notes` (freeform text, bounded at 32 KiB — an over-cap write is REJECTED, never truncated). The block is folded into every future turn of this session; a cancelled or errored turn does not lose a persisted note. An empty string clears the block. Never write secrets into notes. Note writes land on the NEXT model round/turn (the fold is not hot).",
    inputSchema: jsonSchema<{ notes: string }>({
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          description:
            'The full replacement working-notes text (findings, decisions, open questions for this session). Empty string clears the block. Over 32 KiB UTF-8 is rejected, never truncated. NEVER include secrets.',
        },
      },
      required: ['notes'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const raw = input?.notes;
      if (typeof raw !== 'string') {
        return 'ERROR working_notes_update: notes must be a string';
      }
      const cleaned = sanitizeWorkingNotes(raw);
      if (cleaned === undefined && raw.trim() !== '') {
        return `ERROR working_notes_update: notes exceed the ${WORKING_NOTES_MAX_BYTES} byte (32 KiB) cap — shorten the block (never truncated; existing notes unchanged)`;
      }
      try {
        const resolved = await resolveEnvelopeStore(opts);
        if (!resolved.ok) {
          // Honest fail-soft: the in-turn value exists but nothing persisted.
          return `working notes updated in-turn; persistence unavailable (${resolved.error})`;
        }
        const { store, key, envelope } = resolved;
        const persisted = await persistNotesPatch(
          store,
          overlayWriter,
          key,
          envelope,
          cleaned === undefined ? { workingNotes: '' } : { workingNotes: cleaned },
        );
        if (!persisted) {
          return 'working notes updated in-turn; persistence unavailable (envelope changed concurrently and could not be re-stored — no false success)';
        }
        const bytes = new TextEncoder().encode(cleaned ?? '').length;
        return cleaned === undefined
          ? 'working notes cleared — this is a new mind for this session'
          : `working notes updated (${bytes} bytes) — this block is folded into every future turn of this session`;
      } catch (err) {
        return errText('working_notes_update', err);
      }
    },
  });

  const workingNotesClear = tool({
    description:
      "Clear the session's agent-authored working-notes block (meta.workingNotes drops to unset). The next turns see no working-notes block. Use when the accumulated notes are stale or wrong — a fresh mind for this session.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const resolved = await resolveEnvelopeStore(opts);
        if (!resolved.ok) {
          return `working notes cleared in-turn; persistence unavailable (${resolved.error})`;
        }
        const { store, key, envelope } = resolved;
        const persisted = await persistNotesPatch(
          store,
          overlayWriter,
          key,
          envelope,
          { workingNotes: '' },
        );
        if (!persisted) {
          return 'working notes cleared in-turn; persistence unavailable (envelope changed concurrently — no false success)';
        }
        return 'working notes cleared — this is a new mind for this session';
      } catch (err) {
        return errText('working_notes_clear', err);
      }
    },
  });

  return {
    working_notes_get: workingNotesGet,
    working_notes_update: workingNotesUpdate,
    working_notes_clear: workingNotesClear,
  };
}
