import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatTurnSse } from '../workflows/turnSseFormat';
import { parseSseChunk } from '../agentSse';
import {
  isTerminalRunStatus,
  pipeRunReadable,
  type RunStatusHandle,
} from './pipeRunReadable';
import { TURN_STREAM_STATUS_POLL_MS } from '../sessionCloudCaps';

function hangingReadable(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* never enqueue / close */
    },
    cancel() {
      onCancel?.();
    },
  });
}

function chunksReadable(
  chunks: Array<Uint8Array | string>,
): ReadableStream<Uint8Array | string> {
  return new ReadableStream<Uint8Array | string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** Enqueue then hang (never close) — C16 completed-run replay vs inject. */
function bufferedThenHang(
  chunks: Array<Uint8Array | string>,
  onCancel?: () => void,
): ReadableStream<Uint8Array | string> {
  return new ReadableStream<Uint8Array | string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('B11: helper stays off the workflow graph', () => {
  it('turnWorkflow.ts does not import pipeRunReadable', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/workflows/turnWorkflow.ts'),
      'utf8',
    );
    expect(src).not.toContain('pipeRunReadable');
  });
});

describe('isTerminalRunStatus', () => {
  it('C15 three: completed / failed / cancelled', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('pending')).toBe(false);
    expect(isTerminalRunStatus('other')).toBe(false);
  });
});

describe('pipeRunReadable', () => {
  it('cap is 1000 ms', () => {
    expect(TURN_STREAM_STATUS_POLL_MS).toBe(1000);
  });

  it('cancelled + hanging readable → one Request cancelled. error; no run.cancel', async () => {
    const cancel = vi.fn();
    const run: RunStatusHandle & { cancel: () => void } = {
      status: Promise.resolve('cancelled'),
      cancel,
    };
    let underlyingCancel = 0;
    const out = pipeRunReadable(run, hangingReadable(() => {
      underlyingCancel += 1;
    }));
    const text = await readAll(out);
    const { events } = parseSseChunk(text + '\n\n');
    expect(events).toEqual([{ type: 'error', error: 'Request cancelled.' }]);
    expect(text).toBe(formatTurnSse({ type: 'error', error: 'Request cancelled.' }));
    expect(cancel).not.toHaveBeenCalled();
    expect(underlyingCancel).toBeGreaterThanOrEqual(1);
  });

  it('completed + hanging readable, no producer done → one SSE done, not error', async () => {
    const run: RunStatusHandle = { status: Promise.resolve('completed') };
    const text = await readAll(pipeRunReadable(run, hangingReadable()));
    expect(text).toBe(formatTurnSse({ type: 'done', text: '' }));
    expect(text).not.toContain('error');
  });

  it('completed + buffered text_delta then hang → delta then done; inject does not precede', async () => {
    const delta = formatTurnSse({ type: 'text_delta', text: 'Hi' });
    const run: RunStatusHandle = { status: Promise.resolve('completed') };
    const text = await readAll(pipeRunReadable(run, bufferedThenHang([delta])));
    expect(text.startsWith(delta)).toBe(true);
    expect(text).toBe(delta + formatTurnSse({ type: 'done', text: '' }));
  });

  it('failed + hanging readable → one Turn failed. error', async () => {
    const run: RunStatusHandle = { status: Promise.resolve('failed') };
    const text = await readAll(pipeRunReadable(run, hangingReadable()));
    expect(text).toBe(formatTurnSse({ type: 'error', error: 'Turn failed.' }));
  });

  it('running + EOF without producer terminal → close without inject', async () => {
    const run: RunStatusHandle = { status: Promise.resolve('running') };
    const text = await readAll(pipeRunReadable(run, chunksReadable([])));
    expect(text).toBe('');
  });

  it('producer error already forwarded, then terminal status → no second terminal', async () => {
    const err = formatTurnSse({ type: 'error', error: 'model died' });
    const run: RunStatusHandle = { status: Promise.resolve('cancelled') };
    const text = await readAll(
      pipeRunReadable(run, chunksReadable([err]), { pollMs: 5 }),
    );
    const { events } = parseSseChunk(text + '\n\n');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: 'error', error: 'model died' });
  });

  it('tool_result containing the letters done does not count as producer terminal', async () => {
    const tool = formatTurnSse({
      type: 'tool_result',
      name: 'exec',
      ok: true,
      summary: 'printed "type":"done" in stdout',
    });
    const run: RunStatusHandle = { status: Promise.resolve('cancelled') };
    const text = await readAll(pipeRunReadable(run, chunksReadable([tool])));
    const { events } = parseSseChunk(text + '\n\n');
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.error === 'Request cancelled.')).toBe(
      true,
    );
  });

  it('client cancel of wrapper cancels underlying reader, never run.cancel', async () => {
    const runCancel = vi.fn();
    const run: RunStatusHandle & { cancel: () => void } = {
      status: Promise.resolve('running'),
      cancel: runCancel,
    };
    let underlyingCancel = 0;
    const wrapped = pipeRunReadable(
      run,
      hangingReadable(() => {
        underlyingCancel += 1;
      }),
    );
    await wrapped.cancel();
    expect(runCancel).not.toHaveBeenCalled();
    expect(underlyingCancel).toBe(1);
  });

  it('forwards string chunks as UTF-8 bytes', async () => {
    const line = formatTurnSse({ type: 'text_delta', text: 'hi' });
    const run: RunStatusHandle = { status: Promise.resolve('running') };
    const text = await readAll(pipeRunReadable(run, chunksReadable([line])));
    expect(text).toBe(line);
  });

  it('forwards Uint8Array chunks', async () => {
    const line = formatTurnSse({ type: 'text_delta', text: 'ab' });
    const run: RunStatusHandle = { status: Promise.resolve('running') };
    const text = await readAll(
      pipeRunReadable(run, chunksReadable([new TextEncoder().encode(line)])),
    );
    expect(text).toBe(line);
  });

  it('live running then cancelled on poll injects error', async () => {
    let status = 'running';
    const run: RunStatusHandle = {
      get status() {
        return Promise.resolve(status);
      },
    };
    const wrapped = pipeRunReadable(run, hangingReadable(), { pollMs: 20 });
    const consumed = readAll(wrapped);
    await new Promise((r) => setTimeout(r, 15));
    status = 'cancelled';
    const text = await consumed;
    expect(text).toBe(formatTurnSse({ type: 'error', error: 'Request cancelled.' }));
  });
});
