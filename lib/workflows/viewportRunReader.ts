/** Structural SDK adapter: routes inject their authorized public getRun handle. No keys or run-input reads. */
import { sanitizeTurnStreamCursor } from '../sessionCloudCaps';

export type ViewportRun = {
  readonly status: PromiseLike<string> | string;
  getReadable(opts?: { startIndex?: number }): ReadableStream<string | Uint8Array> & {
    getTailIndex?: () => Promise<number>;
  };
};
export type ViewportRunReader = {
  status(): Promise<string>;
  nextIndex(): Promise<number>;
  open(startIndex: number): ReadableStream<string | Uint8Array>;
};
export function createViewportRunReader(run: ViewportRun): ViewportRunReader {
  return {
    status: async () => await run.status,
    open: startIndex => run.getReadable({ startIndex }),
    async nextIndex() {
      // The public helper rides a readable. Start at the tail (never origin),
      // cancel its data side immediately, and only await the metadata request.
      // A hung metadata probe must not leave an unconsumed SDK reader running.
      const stream = run.getReadable({ startIndex: -1 });
      let tail: Promise<number>;
      try {
        if (!stream.getTailIndex) throw new Error('Viewport tail unavailable');
        tail = stream.getTailIndex();
      } finally { void stream.cancel().catch(() => {}); }
      const next = sanitizeTurnStreamCursor((await tail) + 1);
      if (next === undefined) throw new Error('Invalid viewport tail');
      return next;
    },
  };
}

/** Deadline/abort race with listener and timer cleanup; late rejections are always observed. */
export function viewportWait<T>(promise: PromiseLike<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn();
    };
    const abort = () => finish(() => reject(new Error('Viewport read aborted')));
    const timer = setTimeout(() => finish(() => reject(new Error('Viewport read timed out'))), Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(v => finish(() => resolve(v)), e => finish(() => reject(e)));
    if (signal?.aborted) abort();
  });
}
