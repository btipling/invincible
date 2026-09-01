/**
 * Viewport wrapper for durable-turn `getReadable()` streams, plus
 * `bodyForRun` which **does not call `getReadable()`** when `run.status` is
 * already `cancelled`/`failed` (plain synthetic SSE).
 *
 * `getRun().status` is snapshot truth (same three terminal values as the
 * live-only 409 gate on `POST /api/turns`). Platform cancel does not always
 * run the loop `fail()` close, so a raw readable can hang while the run is
 * already terminal. Already-terminal cancelled/failed attach returns a
 * **plain** byte stream (`formatTurnSse`) and never touches the SDK
 * readable. `running`/`completed` still wrap `getReadable()` so a later
 * cancel injects SSE and C16 completed replay can drain.
 *
 * Inject never runs in wrapper `start()` — that would drop C16 replay of a
 * completed run's buffered events. Status for the wrap path is read only
 * from the poll (or on underlying EOF). The first poll is a 0-delay
 * macrotask after a waiting pull.
 *
 * Directive-free: not imported from `turnWorkflow.ts` (B11). Does not import
 * `workflow/api` or `lib/agent/agentStream.ts`.
 */
import { parseSseChunk } from '../agentSse';
import { TURN_STREAM_STATUS_POLL_MS } from '../sessionCloudCaps';
import { formatTurnSse } from '../workflows/turnSseFormat';

/** Structural `getRun()` handle — tests inject a fake; routes pass the SDK run. */
export type RunStatusHandle = {
  readonly status: PromiseLike<string> | string;
};

export type RunReadableHandle = RunStatusHandle & {
  getReadable: (
    opts?: { startIndex?: number },
  ) => ReadableStream<Uint8Array | string>;
};

export type PipeRunReadableOpts = {
  /** Test seam. Production uses `TURN_STREAM_STATUS_POLL_MS`. */
  pollMs?: number;
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const FALLBACK_POLL_MS = 1000;

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status);
}

function resolvePollMs(opts?: PipeRunReadableOpts): number {
  const raw = opts?.pollMs ?? TURN_STREAM_STATUS_POLL_MS;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? raw
    : FALLBACK_POLL_MS;
}

function chunkToText(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}

function sseBytes(event: object): Uint8Array {
  return new TextEncoder().encode(formatTurnSse(event));
}

function injectPayload(status: string): Uint8Array | null {
  if (status === 'cancelled') {
    return sseBytes({ type: 'error', error: 'Request cancelled.' });
  }
  if (status === 'failed') {
    return sseBytes({ type: 'error', error: 'Turn failed.' });
  }
  if (status === 'completed') {
    return sseBytes({ type: 'done', text: '' });
  }
  return null;
}

function timeoutUndefined(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
  });
}

function syntheticTerminal(status: 'cancelled' | 'failed'): ReadableStream<Uint8Array> {
  const bytes = injectPayload(status);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Choose the start/attach Response body **before** touching `getReadable()`.
 * Already-`cancelled`/`failed` → plain synthetic SSE. Else wrap the SDK
 * readable (`startIndex` omitted on POST matches `getReadable()` arity).
 */
export async function bodyForRun(
  run: RunReadableHandle,
  opts?: PipeRunReadableOpts & { startIndex?: number },
): Promise<ReadableStream<Uint8Array>> {
  const pollMs = resolvePollMs(opts);
  const status = await Promise.race([
    Promise.resolve(run.status),
    timeoutUndefined(pollMs),
  ]);
  if (status === 'cancelled' || status === 'failed') {
    return syntheticTerminal(status);
  }
  const readable =
    opts?.startIndex === undefined
      ? run.getReadable()
      : run.getReadable({ startIndex: opts.startIndex });
  return pipeRunReadable(run, readable, opts);
}

/**
 * Pipe `readable` to the client, racing `run.status`. Output is always
 * UTF-8 bytes (host `readAgentStream` is a byte reader).
 */
export function pipeRunReadable(
  run: RunStatusHandle,
  readable: ReadableStream<Uint8Array | string>,
  opts?: PipeRunReadableOpts,
): ReadableStream<Uint8Array> {
  const pollMs = resolvePollMs(opts);
  const encoder = new TextEncoder();

  let reader: ReadableStreamDefaultReader<Uint8Array | string> | undefined;
  let closed = false;
  let sawProducerTerminal = false;
  let sseBuf = '';
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pollStarted = false;
  let pullWaiting = false;

  const stopPoll = (): void => {
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    stopPoll();
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  };

  const enqueueInject = (status: string): boolean => {
    if (closed || sawProducerTerminal) return false;
    const payload = injectPayload(status);
    if (!payload) return false;
    try {
      controllerRef?.enqueue(payload);
    } catch {
      return false;
    }
    sawProducerTerminal = true;
    return true;
  };

  const checkStatus = async (): Promise<boolean> => {
    if (closed) return false;
    try {
      const status = await run.status;
      if (typeof status !== 'string') return false;
      if (enqueueInject(status)) {
        try {
          await reader?.cancel();
        } catch {
          /* consumer cancel / already cancelled */
        }
        closeOnce();
        return true;
      }
    } catch {
      /* fail-soft: hang continues */
    }
    return false;
  };

  const schedulePoll = (delay: number): void => {
    if (closed) return;
    const timer = setTimeout(() => {
      void (async () => {
        if (closed) return;
        // Only inject while a pull is blocked on read (hung producer).
        // Buffered completed-run replay must not be truncated by a 0-delay poll.
        if (pullWaiting && (await checkStatus())) return;
        schedulePoll(pollMs);
      })();
    }, delay);
    timer.unref?.();
    pollTimer = timer;
  };

  const noteProducerTerminal = (chunk: Uint8Array | string): void => {
    sseBuf += chunkToText(chunk);
    const parsed = parseSseChunk(sseBuf);
    sseBuf = parsed.rest;
    for (const ev of parsed.events) {
      if (ev.type === 'done' || ev.type === 'error') sawProducerTerminal = true;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      reader = readable.getReader();
    },
    async pull(controller) {
      if (closed || !reader) return;
      if (!pollStarted) {
        pollStarted = true;
        // 0-delay macrotask: unstick an already-terminal hung readable on
        // the first waiting pull. Does not await status in start().
        schedulePoll(0);
      }
      pullWaiting = true;
      let value: Uint8Array | string | undefined;
      let done = false;
      try {
        const read = await reader.read();
        value = read.value;
        done = read.done;
      } catch {
        pullWaiting = false;
        if (!closed) closeOnce();
        return;
      }
      pullWaiting = false;
      if (closed) return;
      if (done) {
        // Fail-soft: a hung `run.status` must not block client close after
        // the producer EOFs (pre-PR the raw readable would end). Cap the
        // wait at one poll interval; inject if status settles first.
        await Promise.race([
          checkStatus(),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, pollMs);
            t.unref?.();
          }),
        ]);
        closeOnce();
        return;
      }
      if (value !== undefined) {
        noteProducerTerminal(value);
        const bytes = typeof value === 'string' ? encoder.encode(value) : value;
        controller.enqueue(bytes);
      }
    },
    async cancel() {
      closed = true;
      stopPoll();
      try {
        await reader?.cancel();
      } catch {
        /* already cancelled */
      }
    },
  });
}
