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
 * Stream PUT 5xx / 429 / timeout is retried in-process then dropped (live SSE
 * is a viewport; persist is the source of truth). AbortError is never latched.
 */

import { getWritable } from 'workflow';

/** Extra tries after the first write (4 attempts total). NEW cap. */
export const STREAM_WRITE_RETRY_ATTEMPTS = 3;
/** Base backoff ms (doubles each retryable miss). NEW cap. */
export const STREAM_WRITE_RETRY_BASE_MS = 250;
/** Hard cap for any single backoff. NEW cap. */
export const STREAM_WRITE_RETRY_CAP_MS = 4000;

export type StreamWriteErrorClass = 'retryable' | 'abort' | 'drop';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const n = Number((err as { status: unknown }).status);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

function isAbortWriteErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  return (
    name === 'aborterror' ||
    name === 'responseaborted' ||
    name === 'cancelled'
  );
}

function httpCodeFromMessage(msg: string): number | undefined {
  const m = /HTTP\s+(\d{3})\b/i.exec(msg);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Classify a `writer.write` reject. Never classifies the SSE payload.
 *
 * - `retryable` — 5xx / 429 / 408 / Production PUT timeout / Internal Server Error on a stream PUT
 * - `abort` — AbortError / ResponseAborted / name `cancelled` (rethrow, never latch)
 * - `drop` — other writer I/O (4xx except 429/408, unknown)
 */
export function classifyStreamWriteError(err: unknown): StreamWriteErrorClass {
  if (isAbortWriteErr(err)) return 'abort';
  const msg = errorMessage(err);
  const status = errorStatus(err) ?? httpCodeFromMessage(msg);
  if (status !== undefined && isRetryableStatus(status)) return 'retryable';
  if (status !== undefined) return 'drop';
  if (/timed out after \d+\s*ms/i.test(msg)) return 'retryable';
  if (/\btimeout\b/i.test(msg) && /\b(put|stream)\b/i.test(msg)) {
    return 'retryable';
  }
  if (/Internal Server Error/i.test(msg) && /\b(put|stream)\b/i.test(msg)) {
    return 'retryable';
  }
  return 'drop';
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffMs(attempt: number): number {
  return Math.min(
    STREAM_WRITE_RETRY_BASE_MS * 2 ** attempt,
    STREAM_WRITE_RETRY_CAP_MS,
  );
}

/**
 * Retry a single write. Returns `'ok'` or `'drop'` (exhausted / non-retryable).
 * Rethrows abort. `attempt` 0 is the first try.
 */
async function writeOnceWithRetry(
  write: (payload: string) => Promise<void>,
  payload: string,
): Promise<'ok' | 'drop'> {
  for (let attempt = 0; attempt <= STREAM_WRITE_RETRY_ATTEMPTS; attempt++) {
    try {
      await write(payload);
      return 'ok';
    } catch (err) {
      const cls = classifyStreamWriteError(err);
      if (cls === 'abort') throw err;
      if (cls === 'drop') return 'drop';
      if (attempt >= STREAM_WRITE_RETRY_ATTEMPTS) return 'drop';
      await sleepMs(backoffMs(attempt));
    }
  }
  return 'drop';
}

/** Write one already-framed SSE line. Does not close. Releases the writer lock. */
export async function writeOnDefaultStream(payload: string): Promise<void> {
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    await writeOnceWithRetry((p) => writer.write(p), payload);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Hold one Workflows writer for a burst of framed SSE writes.
 * One `getWritable()` / one `getWriter()`; `releaseLock` in `finally`. Does not close.
 * Retryable stream PUT failures retry then latch this writer dead (later writes no-op).
 * AbortError is never latched.
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
      const result = await writeOnceWithRetry((p) => writer.write(p), payload);
      if (result === 'drop') dead = true;
    });
  } finally {
    writer.releaseLock();
  }
}
