import { describe, expect, it, vi } from 'vitest';
import { createViewportRunReader, type ViewportRun } from './viewportRunReader';

describe('public decoded Workflow adapter',()=>{
  it('probes next raw index without consuming frames and closes the probe stream',async()=>{
    const cancel=vi.fn(), getTailIndex=vi.fn(async()=>41);
    const run:ViewportRun={status:Promise.resolve('running'),getReadable:vi.fn(()=>Object.assign(new ReadableStream<string>({cancel}),{getTailIndex}))};
    const adapter=createViewportRunReader(run);
    expect(await adapter.nextIndex()).toBe(42);expect(getTailIndex).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();
    expect(await adapter.status()).toBe('running');
    const readable=adapter.open(42);expect(run.getReadable).toHaveBeenLastCalledWith({startIndex:42});await readable.cancel();
  });
  it.each([-2,1e9,NaN])('rejects invalid tail %s',async tail=>{
    const run:ViewportRun={status:'running',getReadable:()=>Object.assign(new ReadableStream<string>(),{getTailIndex:async()=>tail})};
    await expect(createViewportRunReader(run).nextIndex()).rejects.toThrow();
  });
  it('empty tail -1 is next index0; absent helper is unavailable rather than origin fallback',async()=>{
    const run:ViewportRun={status:'running',getReadable:()=>Object.assign(new ReadableStream<string>(),{getTailIndex:async()=>-1})};
    expect(await createViewportRunReader(run).nextIndex()).toBe(0);
    run.getReadable=()=>new ReadableStream<string>();await expect(createViewportRunReader(run).nextIndex()).rejects.toThrow('unavailable');
  });
});
