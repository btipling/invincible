/**
 * Durable-stream I/O for one turn (plan #842).
 *
 * Workflow SDK: `getWritable()` may be obtained in a workflow function, but
 * `getWriter` / `write` / `close` MUST run in `'use step'` (otherwise
 * `Not supported in workflow functions`). Tokens still ride Data Written on
 * the default stream.
 *
 * `writeTurnSse` stays `'use step'` and delegates the writer lock to
 * directive-free `writeOnDefaultStream`. Live model-step writes call that
 * helper from `modelGenerateStep` (already a step) — they must not call these
 * wrappers (nested `'use step'`).
 */

import { getWritable } from 'workflow';
import { writeOnDefaultStream } from './turnSseWrite';

/** Write one already-framed SSE line. Does not close. Releases the writer lock. */
export async function writeTurnSse(payload: string): Promise<void> {
  'use step';
  await writeOnDefaultStream(payload);
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
