/**
 * Directive-free write onto the Workflows default stream.
 *
 * No `'use step'` / `'use workflow'` — callers already on a step stack
 * (`writeTurnSse`, `modelGenerateStep`) invoke this as a plain function.
 * Import graph: `workflow` only. Does not close.
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
