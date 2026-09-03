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
 * later GET wins.
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
