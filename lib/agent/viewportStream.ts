/** Negotiated snapshot-first/indexed stream. Default legacy transport remains untouched. */
import { TURN_STREAM_STATUS_POLL_MS, sanitizeTurnStreamCursor } from '../sessionCloudCaps';
import { parseViewportEvent, type ViewportView } from '../sessionViewport';
import { encodeViewportRecord, type ViewportRecord } from '../viewportStreamProtocol';
import { recoverViewport } from '../sessions/viewportRead';
import { viewportWait, type ViewportRunReader } from '../workflows/viewportRunReader';
import { isTerminalRunStatus } from './pipeRunReadable';

type FrameResult = { kind: 'frame'; result: ReadableStreamReadResult<string | Uint8Array> } | { kind: 'terminal'; status: string };

function isHangClassStatus(status: string | undefined): status is 'cancelled' | 'failed' {
  return status === 'cancelled' || status === 'failed';
}

/** One pending raw read, one pending status probe at most; stop all timers/listeners on settle. */
function nextFrame(reader: ReadableStreamDefaultReader<string | Uint8Array>, statusProbe: () => Promise<string>, signal: AbortSignal): Promise<FrameResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); fn();
    };
    const abort = () => finish(() => reject(new Error('Viewport detached')));
    const poll = () => {
      if (settled) return;
      // No overlapping status calls, even if the provider never settles.
      void statusProbe().then(status => {
        if (settled) return;
        if (isTerminalRunStatus(status)) finish(() => resolve({ kind: 'terminal', status }));
        else timer = setTimeout(poll, TURN_STREAM_STATUS_POLL_MS);
      }, () => { if (!settled) timer = setTimeout(poll, TURN_STREAM_STATUS_POLL_MS); });
    };
    signal.addEventListener('abort', abort, { once: true });
    void reader.read().then(result => finish(() => resolve({ kind: 'frame', result })), error => finish(() => reject(error)));
    // Let buffered stored frames drain before considering a synthetic terminal.
    // 0-delay first poll matches pipeRunReadable: unstick cancelled/failed hung readables.
    timer = setTimeout(poll, 0);
    if (signal.aborted) abort();
  });
}

export function viewportStream(opts: {
  runId: string; sessionId: string; run: ViewportRunReader; startIndex: number;
  cold?: { readHead: (deadline: number) => Promise<ViewportView>; status: string };
  signal?: AbortSignal;
  /** Recheck session ownership before releasing the recovered snapshot/live stream. */
  stillOwned?: () => Promise<boolean>;
}): ReadableStream<Uint8Array> {
  const aborter = new AbortController();
  const onAbort = () => aborter.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();
  let reader: ReadableStreamDefaultReader<string | Uint8Array> | undefined;
  // Share a stalled provider probe across raw reads; a late frame must not
  // cause the next pull to launch another metadata request beside it.
  let pendingStatus: Promise<string> | undefined;
  const statusProbe = (): Promise<string> => {
    if (!pendingStatus) {
      pendingStatus = Promise.resolve().then(() => opts.run.status());
      void pendingStatus.then(() => { pendingStatus = undefined; }, () => { pendingStatus = undefined; });
    }
    return pendingStatus;
  };
  const cleanup = () => {
    aborter.abort(); opts.signal?.removeEventListener('abort', onAbort);
    if (reader) void reader.cancel().catch(() => {});
  };
  async function* records(): AsyncGenerator<ViewportRecord> {
    let index = opts.startIndex;
    try {
      if (aborter.signal.aborted) return;
      // Same C16 gate as bodyForRun: already-cancelled/failed never touches getReadable.
      const liveStatus = await viewportWait(statusProbe(), TURN_STREAM_STATUS_POLL_MS, aborter.signal).catch(() => undefined);
      const skipReadable = isHangClassStatus(liveStatus);
      if (opts.cold) {
        yield { type: 'viewport_state', version: 1, runId: opts.runId, status: opts.cold.status, phase: 'recovering' };
        const snapshot = await recoverViewport({ runId: opts.runId, sessionId: opts.sessionId,
          initialIndex: index, run: opts.run, readHead: opts.cold.readHead, signal: aborter.signal,
          skipStream: skipReadable });
        if (opts.stillOwned && !(await viewportWait(opts.stillOwned(), TURN_STREAM_STATUS_POLL_MS, aborter.signal)))
          throw new Error('Viewport session changed');
        index = snapshot.resumeIndex;
        yield { type: 'viewport_snapshot', ...snapshot };
        if (skipReadable) {
          yield { type: 'viewport_end', version: 1, runId: opts.runId, status: liveStatus };
          return;
        }
      } else if (skipReadable) {
        yield { type: 'viewport_end', version: 1, runId: opts.runId, status: liveStatus };
        return;
      }
      if (aborter.signal.aborted) return;
      reader = opts.run.open(index).getReader();
      for (;;) {
        const next = await nextFrame(reader, statusProbe, aborter.signal);
        if (next.kind === 'terminal') {
          yield { type: 'viewport_end', version: 1, runId: opts.runId, status: next.status };
          return;
        }
        if (next.result.done) {
          const status = await viewportWait(statusProbe(), TURN_STREAM_STATUS_POLL_MS, aborter.signal).catch(() => 'unknown');
          if (isTerminalRunStatus(status)) yield { type: 'viewport_end', version: 1, runId: opts.runId, status };
          else yield { type: 'viewport_error', version: 1, runId: opts.runId, code: 'STREAM_ENDED' };
          return;
        }
        const value = next.result.value;
        const text = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value);
        const event = parseViewportEvent(text);
        const nextIndex = sanitizeTurnStreamCursor(index + 1);
        if (nextIndex === undefined) throw new Error('Viewport cursor exhausted');
        index = nextIndex;
        yield event ? { type: 'turn_event', version: 1, runId: opts.runId, nextIndex, event }
          : { type: 'turn_event', version: 1, runId: opts.runId, nextIndex, skipped: true };
        if (event?.type === 'done' || event?.type === 'error') return;
      }
    } catch {
      if (!aborter.signal.aborted) yield { type: 'viewport_error', version: 1, runId: opts.runId, code: 'STREAM_UNAVAILABLE' };
    } finally { cleanup(); }
  }
  const iterator = records();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (closed) return;
      if (next.done) { closed = true; controller.close(); }
      else controller.enqueue(encodeViewportRecord(next.value));
    },
    cancel() {
      closed = true; cleanup();
      void iterator.return(undefined).catch(() => {});
    },
  });
}