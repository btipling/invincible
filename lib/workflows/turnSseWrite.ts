/**
 * Directive-free write onto the Workflows default stream.
 *
 * No `'use step'` / `'use workflow'` — callers already on a step stack
 * (`writeTurnSse`, `modelGenerateStep`) invoke this as a plain function.
 * Import graph: `workflow` only. Does not close.
 *
 * Live model-step tokens must use `withDefaultStreamWriter` (one `getWritable`
 * + held writer for the round). `writeOnDefaultStream` is the sparse loop path
 * (one write per `'use step'` call). Do not call `getWritable()` per token.
 */

import { getWritable } from 'workflow';

/** Write one already-framed SSE line. Does not close. Releases the writer lock. */
export async function writeOnDefaultStream(payload: string): Promise<void> {
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    await writer.write(payload);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Hold one Workflows writer for a burst of framed SSE writes.
 * One `getWritable()` / one `getWriter()`; `releaseLock` in `finally`. Does not close.
 */
export async function withDefaultStreamWriter<T>(
  fn: (write: (payload: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    return await fn(async (payload) => {
      await writer.write(payload);
    });
  } finally {
    writer.releaseLock();
  }
}
