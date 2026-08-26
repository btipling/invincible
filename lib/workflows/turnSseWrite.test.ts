/**
 * withDefaultStreamWriter holds one Workflows writer for a burst of writes.
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

import { withDefaultStreamWriter, writeOnDefaultStream } from './turnSseWrite';

afterEach(() => {
  harness.write.mockClear();
  harness.releaseLock.mockClear();
  harness.getWriter.mockClear();
  harness.getWritable.mockClear();
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

  it('releaseLock if write throws mid-burst', async () => {
    harness.write.mockImplementationOnce(async () => {});
    harness.write.mockRejectedValueOnce(new Error('pipe'));
    await expect(
      withDefaultStreamWriter(async (write) => {
        await write('one');
        await write('two');
      }),
    ).rejects.toThrow('pipe');
    expect(harness.write).toHaveBeenCalledTimes(2);
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
});
