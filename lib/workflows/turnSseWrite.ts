/**
 * Directive-free write onto the Workflows default stream.
 *
 * No `'use step'` / `'use workflow'` — callers already on a step stack
 * (`writeTurnSse`, `modelGenerateStep`, `toolExecuteStep`) invoke this as a
 * plain function.
 * Import graph: `workflow` + stdlib only. Does not close.
 *
 * Live model-step tokens must use `withDefaultStreamWriter` (one `getWritable`
 * + held writer for the round). `writeOnDefaultStream` is the sparse loop path
 * (one write per `'use step'` call). Do not call `getWritable()` per token.
 *
 * Stream PUT 5xx / 429 / timeout latch the held writer immediately (Workflows
 * stream appends are not idempotent — SDK `STREAM_RETRY_OPTIONS` retries PUT
 * 429 at the HTTP layer *inside* the first `write()`; after a reject the
 * 4.8.4 sink is sticky-poisoned so a second `write()` cannot PUT). Live SSE
 * is a viewport; persist is the source of truth. AbortError is never latched.
 */

import { getWritable } from 'workflow';

export type StreamWriteErrorClass = 'abort' | 'drop';

function isAbortWriteErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  return (
    name === 'aborterror' ||
    name === 'responseaborted' ||
    name === 'cancelled'
  );
}

/**
 * Classify a `writer.write` reject. Never classifies the SSE payload.
 *
 * Matches workflow@4.8.4 stream-PUT policy (`STREAM_RETRY_OPTIONS` + sticky
 * `sinkError` on `WorkflowServerWritableStream`):
 * - `abort` — AbortError / ResponseAborted / name `cancelled` (rethrow, never latch)
 * - `drop` — 5xx / 429 / timeout / other 4xx / unknown (latch, no app-level
 *   retry). A 5xx / timeout can mean the chunk *was* written. A 429 was
 *   already retried by the SDK dispatcher before `write()` rejected; the
 *   sink is then poisoned so a second `write()` cannot land. The turn still
 *   continues — persist is SoT.
 */
export function classifyStreamWriteError(err: unknown): StreamWriteErrorClass {
  if (isAbortWriteErr(err)) return 'abort';
  return 'drop';
}

/**
 * One write. Returns `'ok'` or `'drop'`. Rethrows abort. No in-process retry
 * — the SDK already retried 429; a reject poisons the held writer.
 */
async function writeOnce(
  write: (payload: string) => Promise<void>,
  payload: string,
): Promise<'ok' | 'drop'> {
  try {
    await write(payload);
    return 'ok';
  } catch (err) {
    if (classifyStreamWriteError(err) === 'abort') throw err;
    return 'drop';
  }
}

/** Write one already-framed SSE line. Does not close. Releases the writer lock. */
export async function writeOnDefaultStream(payload: string): Promise<void> {
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    await writeOnce((p) => writer.write(p), payload);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Hold one Workflows writer for a burst of framed SSE writes.
 * One `getWritable()` / one `getWriter()`; `releaseLock` in `finally`. Does not close.
 * 5xx / 429 / timeout latch this writer dead (later writes no-op). AbortError
 * is never latched.
 */
export async function withDefaultStreamWriter<T>(
  fn: (write: (payload: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  let dead = false;
  try {
    return await fn(async (payload) => {
      if (dead) return;
      const result = await writeOnce((p) => writer.write(p), payload);
      if (result === 'drop') dead = true;
    });
  } finally {
    writer.releaseLock();
  }
}
