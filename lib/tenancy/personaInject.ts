/**
 * Persona injection resolver (parent #485 / phase 3 #488).
 *
 * Server-side only. Turns a user's chosen/bound persona into the agent-system
 * preamble on the first `/api/agent` turn, then locks it into the session
 * `meta.personaSnapshot` so later turns / Continue / device-switch replay the
 * SAME text and a mid-session persona edit NEVER rewrites an in-flight session.
 *
 * Lookup order (fail-closed, no existence leak):
 *   1. `sessionId` present → the scoped session store MUST have the record; read
 *      `meta.personaSnapshot`. Present → use it (later turns / Continue).
 *   2. Else a bound persona id (body `personaId`, else `meta.personaId`) →
 *      `userPersonas.getPersonaById` (scoped) → use the body; best-effort persist
 *      `meta.{personaId,personaSnapshot}` once when a matching session exists.
 *   3. `sessionId` present but NO matching scoped session → **no inject** (never
 *      resolve against an ambiguous session; foreign/absent ids fail closed).
 *   4. No sessionId and no personaId → `undefined` (behaviour identical to today).
 *
 * The snapshot cap is enforced by the server record validator
 * (`validateMetaFields`: `personaSnapshot` ≤ `PERSONA_SNAPSHOT_MAX_BYTES` = 16 KiB,
 * whole `meta` ≤ `HARNESS_SESSION_MAX_META_BYTES` = 20 KiB); an oversized record
 * simply never persists (fail-open — still injected this turn), never a sticky 400.
 *
 * The session store seam is injected so this module never constructs I/O (di-gate).
 * Persistence is best-effort `guardStore`-style: any read/write error → fail-open
 * but still inject the resolved snapshot for THIS turn.
 */
import type {
  HarnessSessionMeta,
  HarnessSessionRecord,
  SessionRecordKey,
} from '../sessions/sessionStore';

/** Minimal persona-body read seam (owned rows only; null = no-row / other-user). */
export type PersonaBodyReader = {
  getPersonaById(
    userId: string,
    personaId: string,
  ): Promise<
    | { ok: true; value: { body: string } | null }
    | { ok: false; error: string }
  >;
};

/** Minimal scoped session-store read/write seam (identity-bound, validated keys). */
export type SessionStoreLite = {
  get(key: SessionRecordKey): Promise<HarnessSessionRecord | null>;
  put(
    key: SessionRecordKey,
    record: HarnessSessionRecord,
  ): Promise<{ status: 'stored' | 'conflict' }>;
};

export type ResolvePersonaPreambleInput = {
  userId: string;
  sessionId?: string;
  personaId?: string;
  sessionStore?: SessionStoreLite;
  sessionKey?: SessionRecordKey;
  userPersonas: PersonaBodyReader;
};

/** Trim the snapshot text; empty/oversized → undefined (never inject junk). */
export function cleanSnapshot(body: string | undefined): string | undefined {
  if (typeof body !== 'string') return undefined;
  const t = body.trim();
  return t ? t : undefined;
}

/** Merge a snapshot into a record's reserved meta (additive; never drops keys). */
export function mergePersonaMeta(
  record: HarnessSessionRecord,
  personaId: string,
  snapshot: string,
): HarnessSessionRecord {
  const meta: HarnessSessionMeta = { ...record.meta, personaId, personaSnapshot: snapshot };
  return { ...record, meta, updatedAt: Date.now() };
}

/**
 * Resolve the persona preamble text for an agent turn, per the locked order above.
 * Returns `undefined` when there is nothing to inject (no persona / no session to
 * read / foreign session → fail-closed).
 */
export async function resolvePersonaPreamble(
  input: ResolvePersonaPreambleInput,
): Promise<string | undefined> {
  const { userId, sessionId, personaId, sessionStore, sessionKey, userPersonas } = input;

  let boundPersonaId = personaId?.trim() || undefined;

  let record: HarnessSessionRecord | null = null;
  if (sessionId && sessionStore && sessionKey) {
    try {
      record = await sessionStore.get(sessionKey);
    } catch {
      // Session store unavailable → fail open (still may inject from a body id).
      record = null;
    }
  }

  if (record) {
    const snap = record.meta?.personaSnapshot;
    if (typeof snap === 'string' && snap.trim()) {
      // Later turn / Continue: reuse the locked snapshot; a mid-session persona
      // edit never rewrites this in-flight session.
      return cleanSnapshot(snap);
    }
    // Cloud-bound persona preference (set at mint) fills a missing body id.
    if (!boundPersonaId && typeof record.meta?.personaId === 'string') {
      boundPersonaId = record.meta.personaId;
    }
  } else if (sessionId) {
    // sessionId present but NO matching scoped session → fail closed: never
    // resolve against an ambiguous/foreign session (no existence leak).
    return undefined;
  }

  if (!boundPersonaId) return undefined;

  let body: string | undefined;
  try {
    const persona = await userPersonas.getPersonaById(userId, boundPersonaId);
    if (!persona.ok) return undefined; // unavailable → no inject (fail closed)
    if (!persona.value) return undefined; // unknown/other-user → no inject (no leak)
    body = persona.value.body;
  } catch {
    return undefined;
  }

  const snapshot = cleanSnapshot(body);
  if (!snapshot) return undefined;

  // Best-effort persist once: lock the binding + snapshot into the session meta so
  // later turns / device-switch replay it. Fail-open on any store error (the
  // snapshot still injects THIS turn). Oversized → record validator rejects →
  // not persisted → next turn falls back to resolve again (fail-open).
  if (sessionId && sessionStore && sessionKey && record) {
    try {
      const next = mergePersonaMeta(record, boundPersonaId, snapshot);
      await sessionStore.put(sessionKey, next);
    } catch {
      /* fail-open: ignore persist errors */
    }
  }

  return snapshot;
}
