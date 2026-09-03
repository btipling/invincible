/**
 * After a durable SSE `error` (wall-clock cap, model error) the worker has
 * already terminal-persisted. The host fail path must not flatten-PUT a local
 * snapshot that never ran `done` finalize (per-round assistants were
 * bridge-only) — that PUT LWW-wins and orphans the worker head (source #933).
 *
 * Adopt the worker transcript (GET + reconstruct) for **local paint only**.
 * Always skip the cloud PUT (`skipCloud: true`) so the worker envelope pointer
 * stays LWW source of truth. GET `ok` unions F21 queue / usage via
 * `mergeAdoptedUsage`, keeps the fail-fold `turnStatus` / `turnRunId`, and
 * suffixes host-only error/system rows. GET fail freezes `updatedAt` so a
 * later GET wins — and `shouldHoldCloudPut` keeps the *next* host persist
 * from stamping `Date.now()` onto that thin snapshot and PUT-clobbering.
 */
import { mergeAdoptedUsage } from './sessionRepository';
import type { CloudGetResult } from './sessionRepository';
import type { SessionMessage, SessionSnapshot } from './sessionStore';

export function shouldAdoptWorkerTranscriptOnError(input: {
  ok: boolean;
  streamOpened: boolean;
  turnStatus?: string;
}): boolean {
  return (
    input.ok === false &&
    input.streamOpened === true &&
    input.turnStatus !== 'running' &&
    input.turnStatus !== 'cancelling'
  );
}

/** GET miss (freeze `updatedAt: 0`) — hold cloud PUT until a later GET merges. */
export function shouldHoldCloudPut(adopted: {
  skipCloud: boolean;
  session: { updatedAt: number };
}): boolean {
  return adopted.skipCloud && adopted.session.updatedAt === 0;
}

/**
 * Hold is per-session. A model/effort pick (or any other host persist) on a
 * *different* session must still PUT; only the GET-miss session is fenced.
 */
export function heldSessionPutBlocked(
  hold: boolean,
  heldSessionId: string | null,
  id: string,
): boolean {
  return hold && heldSessionId === id;
}

/**
 * While the GET-miss hold is set, do not stamp `Date.now()` onto the thin
 * snapshot. Freeze-0 is the LWW fence — a newer local clock lets F5 keep-local
 * and boot-PUT the thin row over the worker merged head (source #933).
 */
export function keepFrozenClock(
  blocked: boolean,
  next: SessionSnapshot,
): SessionSnapshot {
  if (!blocked) return next;
  return { ...next, updatedAt: 0 };
}

export type CloudPutFn = (id: string, snapshot: SessionSnapshot) => void;

/** No-op `repo.put` while the held session is fenced. */
export function putUnlessHeld(
  blocked: boolean,
  put: CloudPutFn | undefined,
  id: string,
  snapshot: SessionSnapshot,
): void {
  if (blocked) return;
  put?.(id, snapshot);
}

/** Wrap a repo so `put` no-ops while `blocked`. Other methods pass through. */
export function wrapRepoPut<T extends { put: CloudPutFn }>(
  blocked: boolean,
  repo: T | null,
): T | null {
  if (!repo) return null;
  if (!blocked) return repo;
  return { ...repo, put: () => undefined };
}


const HOST_ONLY_ROLES = new Set<SessionMessage['role']>(['error', 'system']);

/** Local Turn-ended / system rows the worker checkpoint never carries. */
export function withHostOnlySuffix(
  worker: ReadonlyArray<SessionMessage>,
  local: ReadonlyArray<SessionMessage>,
): SessionMessage[] {
  const extras = local.filter((m) => {
    if (!HOST_ONLY_ROLES.has(m.role)) return false;
    return !worker.some((w) => w.role === m.role && w.text === m.text);
  });
  if (extras.length === 0) return worker.slice();
  return [...worker, ...extras];
}

/**
 * Suffix any local-only rows (new user after the wall, ember Turn-ended, …)
 * the worker snapshot lacks. Used when recovering a GET-miss before the next
 * host PUT so a follow-up prompt is not dropped and the worker head is not
 * replaced by a thin flatten.
 */
export function withLocalOnlySuffix(
  worker: ReadonlyArray<SessionMessage>,
  local: ReadonlyArray<SessionMessage>,
): SessionMessage[] {
  const extras = local.filter(
    (m) => !worker.some((w) => w.role === m.role && w.text === m.text),
  );
  if (extras.length === 0) return worker.slice();
  return [...worker, ...extras];
}

function keepLocalFailFold(
  merged: SessionSnapshot,
  local: SessionSnapshot,
): SessionSnapshot {
  const out: SessionSnapshot = {
    ...merged,
    messages: withHostOnlySuffix(merged.messages, local.messages),
  };
  if (local.turnStatus !== undefined) out.turnStatus = local.turnStatus;
  else delete out.turnStatus;
  if (local.turnRunId !== undefined) out.turnRunId = local.turnRunId;
  else delete out.turnRunId;
  if (local.turnStreamCursor !== undefined) {
    out.turnStreamCursor = local.turnStreamCursor;
  } else {
    delete out.turnStreamCursor;
  }
  return out;
}

export async function adoptWorkerTranscriptOnError(opts: {
  get: ((id: string) => Promise<CloudGetResult>) | undefined;
  session: SessionSnapshot;
}): Promise<{ session: SessionSnapshot; skipCloud: boolean }> {
  if (!opts.get) {
    return {
      session: { ...opts.session, updatedAt: 0 },
      skipCloud: true,
    };
  }
  try {
    const pulled = await opts.get(opts.session.id);
    if (pulled.action === 'ok') {
      return {
        session: keepLocalFailFold(
          mergeAdoptedUsage(pulled.snapshot, opts.session),
          opts.session,
        ),
        skipCloud: true,
      };
    }
  } catch {
    /* GET blip — do not flatten-clobber the worker pointer */
  }
  return {
    session: { ...opts.session, updatedAt: 0 },
    skipCloud: true,
  };
}

/**
 * After an error-adopt GET miss (`shouldHoldCloudPut`), GET+merge the worker
 * head before the next host PUT. GET ok → worker transcript + local-only
 * suffix, `skipCloud: false` (a flatten of the merged head is safe). GET miss
 * → keep local, `skipCloud: true` (still do not PUT a thin snapshot).
 */
export async function recoverWorkerTranscriptBeforePut(opts: {
  get: ((id: string) => Promise<CloudGetResult>) | undefined;
  session: SessionSnapshot;
}): Promise<{ session: SessionSnapshot; skipCloud: boolean }> {
  if (!opts.get) {
    return { session: opts.session, skipCloud: true };
  }
  try {
    const pulled = await opts.get(opts.session.id);
    if (pulled.action === 'ok') {
      const merged = mergeAdoptedUsage(pulled.snapshot, opts.session);
      return {
        session: {
          ...merged,
          messages: withLocalOnlySuffix(merged.messages, opts.session.messages),
        },
        skipCloud: false,
      };
    }
  } catch {
    /* still cannot see the worker head */
  }
  return { session: opts.session, skipCloud: true };
}
