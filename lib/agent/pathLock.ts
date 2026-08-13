/**
 * Per-path async mutex (single-flight per key, FIFO). Used to serialize the
 * read→apply→write critical section of the FS apply tools (`str_replace` /
 * `write_file`) so two overlapping applies to the same path never interleave a
 * stale snapshot and silently drop an edit (bug #479).
 *
 * Pure TS — constructs no I/O, so it is safe under the repo DI gate. A caller
 * wraps its apply in `withPathLock(path, fn)`; waiters for the same `path`
 * queue FIFO. An aborted waiter that has not yet started fails closed and
 * releases its slot so later waiters are not blocked ("abort-in-hole").
 *
 * Use one instance per serialization domain:
 *  - host tools (`lib/agent/tools.ts`): a shared module instance so every
 *    apply routed through the host closes the same-turn parallel race;
 *  - Vercel client (`lib/sandbox/vercelClient.ts`): a per-client-instance
 *    lock over that client's own read→write window (scoped to one request);
 *  - the BYO daemon (`sandbox/tools.mjs`) uses its own JS twin.
 */

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

export class PathLock {
  private tails = new Map<string, Promise<void>>();

  /**
   * Serialize `fn` per `path` within this lock instance (FIFO per key).
   * If `signal` aborts while this call is still queued (has not started `fn`),
   * the call rejects with an `AbortError` and releases its slot so the next
   * waiter proceeds. Once `fn` has started, abort is the caller's job (it
   * passes `signal` through to the client calls inside `fn`); the slot is held
   * until `fn` settles.
   */
  withPathLock<T>(
    path: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const prev = this.tails.get(path) ?? Promise.resolve();

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next op in this path's chain resolves once the previous holder
    // settles AND our gate is released.
    const tail = prev.then(() => gate);
    this.tails.set(path, tail);

    const releaseSlot = () => {
      if (this.tails.get(path) === tail) this.tails.delete(path);
    };

    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;

      const finish = (err?: unknown, val?: T) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        release();
        releaseSlot();
        if (err) reject(err);
        else resolve(val as T);
      };

      const onAbort = () => {
        // Aborted while queued — fail closed NOW (do not wait for the previous
        // holder), release our slot, and never run `fn`. Once `fn` has started,
        // abort is the caller's job (it passes `signal` through); we only
        // finalize when `fn` settles.
        if (!started) finish(abortError());
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      void (async () => {
        if (prev) await prev; // FIFO: wait our turn
        if (settled) return; // aborted while queued — already rejected
        if (signal?.aborted) {
          finish(abortError());
          return;
        }
        started = true;
        try {
          finish(undefined, await fn());
        } catch (err) {
          finish(err);
        }
      })();
    });
  }
}

/** Shared unit instance used by the host FS tools (module singleton). */
export const defaultPathLock = new PathLock();
