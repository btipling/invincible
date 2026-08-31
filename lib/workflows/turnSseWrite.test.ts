/**
 * withDefaultStreamWriter holds one Workflows writer for a burst of writes.
 * Stream PUT 5xx/429/timeout latch immediately; AbortError rethrows.
 * Mock `workflow` `getWritable` — do not call the real SDK.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const write = vi.fn(async (_payload: string) => {});
  const releaseLock = vi.fn();
  const getWriter = vi.fn(() => ({ write, releaseLock }));
  const getWritable = vi.fn(() => ({ getWriter }));
  return { write, releaseLock, getWriter, getWritable };
});

vi.mock('workflow', () => ({
  getWritable: harness.getWritable,
}));

import {
  classifyStreamWriteError,
  withDefaultStreamWriter,
  writeOnDefaultStream,
} from './turnSseWrite';

const HTTP_500 =
  'Stream write failed: HTTP 500 (PUT https://vercel-workflow.com/api/v2/runs/wrun_x/stream/strm_x_user): Internal Server Error';
const PUT_TIMEOUT =
  'PUT /api/v2/runs/wrun_x/stream/strm_x_user timed out after 30002ms';
const HTTP_429 = 'HTTP 429 Too Many Requests';

function abortErr(message = 'aborted'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

afterEach(() => {
  harness.write.mockReset();
  harness.write.mockImplementation(async () => {});
  harness.releaseLock.mockClear();
  harness.getWriter.mockClear();
  harness.getWritable.mockClear();
});

describe('classifyStreamWriteError', () => {
  it('Production HTTP 500 stream PUT is drop (not retried — append not idempotent)', () => {
    expect(classifyStreamWriteError(new Error(HTTP_500))).toBe('drop');
  });

  it('Production PUT timeout is drop (not retried — append not idempotent)', () => {
    expect(classifyStreamWriteError(new Error(PUT_TIMEOUT))).toBe('drop');
  });

  it('429 (status or HTTP in message) is drop — SDK already retried; sink is poisoned', () => {
    expect(classifyStreamWriteError(new Error(HTTP_429))).toBe('drop');
    expect(classifyStreamWriteError({ message: 'nope', status: 429 })).toBe(
      'drop',
    );
  });

  it('AbortError / ResponseAborted / name cancelled is abort', () => {
    expect(classifyStreamWriteError(abortErr())).toBe('abort');
    const ra = new Error('closed');
    ra.name = 'ResponseAborted';
    expect(classifyStreamWriteError(ra)).toBe('abort');
    const c = new Error('x');
    c.name = 'cancelled';
    expect(classifyStreamWriteError(c)).toBe('abort');
  });

  it('HTTP 400 is drop (no retry)', () => {
    expect(classifyStreamWriteError(new Error('HTTP 400 Bad Request'))).toBe(
      'drop',
    );
  });

  it('HTTP 408 is drop', () => {
    expect(classifyStreamWriteError(new Error('HTTP 408 Request Timeout'))).toBe(
      'drop',
    );
  });

  it('does not classify the SSE payload; unknown errors drop', () => {
    expect(classifyStreamWriteError(new Error('disk full'))).toBe('drop');
  });

  it('Internal Server Error on a stream PUT is drop', () => {
    expect(
      classifyStreamWriteError(
        new Error('Internal Server Error on PUT /stream/strm_x_user'),
      ),
    ).toBe('drop');
  });
});

describe('withDefaultStreamWriter', () => {
  it('N writes → 1 getWritable, 1 getWriter, N write in order, 1 releaseLock', async () => {
    const payloads = ['a', 'b', 'c'];
    const out = await withDefaultStreamWriter(async (write) => {
      for (const p of payloads) await write(p);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(harness.getWritable).toHaveBeenCalledTimes(1);
    expect(harness.getWriter).toHaveBeenCalledTimes(1);
    expect(harness.write.mock.calls.map((c) => c[0])).toEqual(payloads);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('releaseLock if fn throws', async () => {
    await expect(
      withDefaultStreamWriter(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(harness.getWritable).toHaveBeenCalledTimes(1);
    expect(harness.getWriter).toHaveBeenCalledTimes(1);
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('500 latches immediately — later writes no-op, fn still returns', async () => {
    harness.write.mockRejectedValue(new Error(HTTP_500));
    const out = await withDefaultStreamWriter(async (write) => {
      await write('one');
      await write('two');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.write.mock.calls[0][0]).toBe('one');
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('timeout latches immediately — later writes no-op', async () => {
    harness.write.mockRejectedValue(new Error(PUT_TIMEOUT));
    const out = await withDefaultStreamWriter(async (write) => {
      await write('tok');
      await write('next');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('429 latches immediately — no second SDK write (sink is sticky after reject)', async () => {
    harness.write.mockRejectedValue(new Error(HTTP_429));
    const out = await withDefaultStreamWriter(async (write) => {
      await write('one');
      await write('two');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.write.mock.calls[0][0]).toBe('one');
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 400 → 1 attempt, latch, later writes no-op', async () => {
    harness.write.mockRejectedValue(new Error('HTTP 400 Bad Request'));
    const out = await withDefaultStreamWriter(async (write) => {
      await write('one');
      await write('two');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('AbortError reject → throw, no latch of later writes (fn does not continue), releaseLock', async () => {
    harness.write.mockRejectedValueOnce(abortErr());
    await expect(
      withDefaultStreamWriter(async (write) => {
        await write('one');
        await write('two');
        return 'ok';
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('ordered payloads concatenate in write order', async () => {
    await withDefaultStreamWriter(async (write) => {
      await write('data: {"type":"text_delta","text":"Let "}\n\n');
      await write('data: {"type":"text_delta","text":"me"}\n\n');
    });
    const joined = harness.write.mock.calls.map((c) => c[0] as string).join('');
    expect(joined).toBe(
      'data: {"type":"text_delta","text":"Let "}\n\n' +
        'data: {"type":"text_delta","text":"me"}\n\n',
    );
  });
});

describe('writeOnDefaultStream (sparse loop path)', () => {
  it('acquires and releases per call', async () => {
    await writeOnDefaultStream('one');
    await writeOnDefaultStream('two');
    expect(harness.getWritable).toHaveBeenCalledTimes(2);
    expect(harness.getWriter).toHaveBeenCalledTimes(2);
    expect(harness.write.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
    expect(harness.releaseLock).toHaveBeenCalledTimes(2);
  });

  it('429 returns void without retry (does not throw)', async () => {
    harness.write.mockRejectedValue(new Error(HTTP_429));
    await expect(writeOnDefaultStream('line')).resolves.toBeUndefined();
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('500 returns void without retry (does not throw)', async () => {
    harness.write.mockRejectedValue(new Error(HTTP_500));
    await expect(writeOnDefaultStream('line')).resolves.toBeUndefined();
    expect(harness.write).toHaveBeenCalledTimes(1);
    expect(harness.releaseLock).toHaveBeenCalledTimes(1);
  });
});
