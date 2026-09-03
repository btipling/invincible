/**
 * After a durable SSE `error` (wall-clock cap, model error) the worker has
 * already terminal-persisted. The host fail path must not flatten-PUT a local
 * snapshot that never ran `done` finalize (per-round assistants were
 * bridge-only) — that PUT LWW-wins and orphans the worker head (source #933).
 *
 * Adopt the worker transcript (GET + reconstruct) before persist. If GET is
 * unavailable, skip the cloud PUT and freeze `updatedAt` so a later GET wins.
 */
import type { CloudGetResult } from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';

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
      return { session: pulled.snapshot, skipCloud: false };
    }
  } catch {
    /* GET blip — do not flatten-clobber the worker pointer */
  }
  return {
    session: { ...opts.session, updatedAt: 0 },
    skipCloud: true,
  };
}
