import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewportStream } from './viewportStream';
import { emptyViewport } from '../sessions/viewportRead';
import { ViewportStreamDecoder, type ViewportRecord } from '../viewportStreamProtocol';
import type { ViewportRunReader } from '../workflows/viewportRunReader';
const line = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
async function collect(stream: ReadableStream<Uint8Array>, initial?:number) {
  const reader = stream.getReader(), parser = new ViewportStreamDecoder('run',initial);
  const records: ViewportRecord[] = [];
  for (;;) { const {done,value}=await reader.read(); if(done)break; records.push(...parser.push(value)); }
  parser.push(new Uint8Array(),true); return records;
}
afterEach(()=>vi.useRealTimers());

describe('snapshot-first and indexed live transport',()=>{
  it('emits state/snapshot, skips historical thinking/backlog and paints only post-H live events',async()=>{
    const run:ViewportRunReader={status:async()=> 'running',nextIndex:async()=>100,
      open:vi.fn(start=>new ReadableStream({start(c){
        const events=start===0 ? [{type:'reasoning_delta',text:'old-secret-think'},{type:'text_delta',text:'sampled tail'}]
          :[{type:'reasoning_delta',text:'new live thinking'},{type:'text_delta',text:'new text'},{type:'done',text:'all text'}];
        for(const e of events)c.enqueue(line(e)); c.close();
      }}))};
    const records=await collect(viewportStream({runId:'run',sessionId:'session',startIndex:2,run,
      cold:{status:'cancelling',readHead:async()=>emptyViewport('session')}}));
    expect(records.map(r=>r.type)).toEqual(['viewport_state','viewport_snapshot','turn_event','turn_event','turn_event']);
    expect(records[0]).toMatchObject({status:'cancelling'});
    expect(records[1]).toMatchObject({resumeIndex:100,gap:true,source:'stream_tail'});
    expect(JSON.stringify(records)).not.toContain('old-secret-think');
    expect(records[2]).toMatchObject({nextIndex:101,event:{type:'reasoning_delta',text:'new live thinking'}});
    expect(run.open).toHaveBeenNthCalledWith(1,0); expect(run.open).toHaveBeenNthCalledWith(2,100);
  });
  it('known malformed frame is skipped at its raw index; EOF synthesizes no stored index',async()=>{
    const run:ViewportRunReader={status:async()=> 'completed',nextIndex:async()=>0,open:()=>new ReadableStream({start(c){c.enqueue('broken');c.close();}})};
    const records=await collect(viewportStream({runId:'run',sessionId:'session',run,startIndex:9}),9);
    expect(records).toEqual([{type:'turn_event',version:1,runId:'run',nextIndex:10,skipped:true},{type:'viewport_end',version:1,runId:'run',status:'completed'}]);
  });
  it('invalid UTF-8 means unknown position and closes with error, not skipped index',async()=>{
    const run:ViewportRunReader={status:async()=> 'running',nextIndex:async()=>0,open:()=>new ReadableStream({start(c){c.enqueue(new Uint8Array([255]));}})};
    expect(await collect(viewportStream({runId:'run',sessionId:'session',run,startIndex:9}),9))
      .toEqual([{type:'viewport_error',version:1,runId:'run',code:'STREAM_UNAVAILABLE'}]);
  });
  it('session revoked before handoff cannot release snapshot or live data',async()=>{
    const run:ViewportRunReader={status:async()=> 'running',nextIndex:async()=>0,open:vi.fn()};
    const records=await collect(viewportStream({runId:'run',sessionId:'session',run,startIndex:0,
      cold:{status:'running',readHead:async()=>emptyViewport('session')},stillOwned:async()=>false}));
    expect(records.map(r=>r.type)).toEqual(['viewport_state','viewport_error']);expect(run.open).not.toHaveBeenCalled();
  });
  it('cancel/disconnect unblocks pending read and cleans timers without cancelling the run',async()=>{
    vi.useFakeTimers();const cancel=vi.fn();const run:ViewportRunReader={status:vi.fn(async()=> 'running'),nextIndex:async()=>0,
      open:()=>new ReadableStream({cancel})};
    const controller=new AbortController();
    const result=collect(viewportStream({runId:'run',sessionId:'session',run,startIndex:0,signal:controller.signal}),0);
    await Promise.resolve();controller.abort();
    expect(await result).toEqual([]);expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('shares a stalled status probe across frames and EOF instead of piling up requests', async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<string | Uint8Array>;
    const status = vi.fn(() => new Promise<string>(() => {}));
    const run: ViewportRunReader = {
      status, nextIndex: async () => 0,
      open: () => new ReadableStream({ start(controller) { source = controller; } }),
    };
    const result = collect(viewportStream({ runId: 'run', sessionId: 'session', run, startIndex: 0 }), 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledOnce();
    source.enqueue(line({ type: 'text_delta', text: 'late frame' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledOnce();
    source.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).map(record => record.type)).toEqual(['turn_event', 'viewport_error']);
    expect(status).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['completed','failed','cancelled'])('polls a hung readable and emits synthetic %s with no fake index',async status=>{
    vi.useFakeTimers();const cancel=vi.fn();const run:ViewportRunReader={status:async()=>status,nextIndex:async()=>0,
      open:()=>new ReadableStream({cancel})};
    const result=collect(viewportStream({runId:'run',sessionId:'session',run,startIndex:42}),42);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual([{type:'viewport_end',version:1,runId:'run',status}]);
    expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
});
