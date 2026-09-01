/**
 * Viewport wrapper for durable-turn `getReadable()` streams.
 *
 * `getRun().status` is snapshot truth (same three terminal values as the
 * live-only 409 gate on `POST /api/turns`). Platform cancel does not always
 * run the loop `fail()` close, so a raw readable can hang while the run is
 * already terminal. This wrapper injects one existing SSE terminal
 * (`formatTurnSse`) and closes the **client** stream. It never calls
 * `run.cancel()` — abort ≠ cancel.
 *
 * Inject never runs in `start()` before a pull: that would drop C16 replay
 * of a completed run's buffered events. Status is still read immediately;
 * if it is already terminal, the first poll delay is 0 so a hung attach
 * unsticks on the first waiting pull (macrotask, after a queued read).
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
  let terminalAtSubscribe = false;
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
    async start(controller) {
      controllerRef = controller;
      reader = readable.getReader();
      try {
        const status = await run.status;
        terminalAtSubscribe =
          typeof status === 'string' && isTerminalRunStatus(status);
      } catch {
        /* fail-soft */
      }
    },
    async pull(controller) {
      if (closed || !reader) return;
      if (!pollStarted) {
        pollStarted = true;
        schedulePoll(terminalAtSubscribe ? 0 : pollMs);
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
        await checkStatus();
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
