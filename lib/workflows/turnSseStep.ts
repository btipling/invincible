/**
 * Durable-stream I/O for one turn (plan #842).
 *
 * Workflow SDK: `getWritable()` may be obtained in a workflow function, but
 * `getWriter` / `write` / `close` MUST run in `'use step'` (otherwise
 * `Not supported in workflow functions`). Tokens still ride Data Written on
 * the default stream.
 *
 * Import graph: `workflow` + nothing else. Framing lives in `turnSseFormat.ts`.
 */

import { getWritable } from 'workflow';

/** Write one already-framed SSE line. Does not close. Releases the writer lock. */
export async function writeTurnSse(payload: string): Promise<void> {
  'use step';
  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    await writer.write(payload);
  } finally {
    writer.releaseLock();
  }
}

/** Close the default writable. Idempotent — a second close is fail-soft. */
export async function closeTurnSse(): Promise<void> {
  'use step';
  const writable = getWritable<string>();
  try {
    await writable.close();
  } catch {
    // already closed / lock released
  }
}
