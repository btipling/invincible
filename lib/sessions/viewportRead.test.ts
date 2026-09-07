import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBlobTranscriptStore } from './blobStores';
import { newBlobObjectId } from './blobStore';
import { emptyViewport, readViewportHead, recoverViewport } from './viewportRead';
import { VIEWPORT_RECOVERY_MAX_BYTES, VIEWPORT_RECOVERY_MAX_MS, VIEWPORT_FINAL_PROBE_MAX_MS } from '../sessionCloudCaps';
import type { ViewportRunReader } from '../workflows/viewportRunReader';

const scope = { tenantId: 'tenant', userId: 'user', sessionId: 'session' };
const line = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const head = () => Promise.resolve(emptyViewport(scope.sessionId));
function runWith(frames: string[], final = frames.length): ViewportRunReader {
  return { nextIndex: vi.fn(async () => final), status: async () => 'running',
    open: vi.fn(start => new ReadableStream({ start(c) { for (const f of frames.slice(start)) c.enqueue(f); c.close(); } })) };
}
afterEach(() => vi.useRealTimers());

describe('one-head viewport source', () => {
  it('reads only scoped head, never prev, validates body id, does not write', async () => {
    const blob = new MemoryBlobTranscriptStore();
    const id = newBlobObjectId(scope); const prev = newBlobObjectId(scope);
    await blob.writeSegment({ objectId: id, maxBytes: 8*1024*1024, content: JSON.stringify({ id: 'session', prev, queue: ['next'],
      messages: Array.from({length: 2500}, (_, i) => ({role:'assistant', text:`message${i}`})) }) });
    const read = vi.spyOn(blob, 'read'), write = vi.spyOn(blob, 'writeSegment');
    const view = await readViewportHead({scope, meta:{transcriptPointer:id, workingNotes:'hidden'}, blob});
    expect(read).toHaveBeenCalledExactlyOnceWith(id); expect(write).not.toHaveBeenCalled();
    expect(view.rows.at(-1)?.text).toBe('message2499'); expect(view.rows).toHaveLength(2048);
    expect(view.hasEarlier).toBe(true); expect(view.carriers.queue).toEqual(['next']);
    expect(JSON.stringify(view)).not.toContain('hidden');
  });
  it('foreign pointer is not read; corrupt/wrong-id/missing heads are optional misses', async () => {
    const read = vi.fn(async () => null as string|null);
    const pointer = newBlobObjectId({...scope, userId:'foreign'});
    expect((await readViewportHead({scope, meta:{transcriptPointer:pointer}, blob:{read}})).replace).toBe(false);
    expect(read).not.toHaveBeenCalled();
    for (const raw of ['bad-json', JSON.stringify({id:'wrong',messages:[{role:'assistant',text:'foreign'}]}), null]) {
      read.mockResolvedValue(raw);
      const view = await readViewportHead({scope, meta:{transcriptPointer:newBlobObjectId(scope)},blob:{read}});
      expect(view.replace).toBe(false);
    }
  });
});

describe('bounded recent stream recovery', () => {
  it('samples 2048 recent frames of a huge run, discards thinking, final probe once and no catch-up chase', async () => {
    const cancel = vi.fn(); let reads = 0;
    const run: ViewportRunReader = { status: async () => 'running', nextIndex: vi.fn(async () => 1000050),
      open: vi.fn(start => new ReadableStream({ pull(c) {
        reads++;
        c.enqueue(line(start + reads === 1000000 ? {type:'text_delta',text:'latest'} : {type:'reasoning_delta',text:'historic'}));
      }, cancel })) };
    const view = await recoverViewport({runId:'run',sessionId:'session',initialIndex:1000000,run,readHead:head});
    expect(run.open).toHaveBeenCalledExactlyOnceWith(1000000-2048);
    // Web Streams may prefetch one raw frame; the application consumes only 2048.
    expect(reads).toBeLessThanOrEqual(2049); expect(cancel).toHaveBeenCalledOnce();
    expect(view.sampledRange).toEqual({start:1000000-2048,end:1000000});
    expect(run.nextIndex).toHaveBeenCalledOnce(); expect(view.resumeIndex).toBe(1000050); expect(view.gap).toBe(true);
    expect(view.rows.some(r=>r.text==='latest')).toBe(true); expect(JSON.stringify(view)).not.toContain('historic"');
  });
  it('chooses sample OR head, never merges ambiguous history; thinking-only sample falls back', async () => {
    const h = {...emptyViewport('session'), source:'stored_head' as const, replace:true,
      rows:[{id:'h',role:'assistant' as const,text:'head-only',at:0}]};
    for (const event of [{type:'text_delta',text:'sample-only'}, {type:'reasoning_delta',text:'never-paint'}]) {
      const run = runWith([line(event)]);
      const view = await recoverViewport({runId:'run',sessionId:'session',initialIndex:1,run,readHead:async()=>h});
      expect(view.rows[0].text).toBe(event.type==='text_delta'?'sample-only':'head-only');
      expect(view.source).toBe(event.type==='text_delta'?'stream_tail':'stored_head');
    }
  });
  it('oversized decoded frame ends optional sample but still attaches at tail', async () => {
    const run = runWith(['x'.repeat(VIEWPORT_RECOVERY_MAX_BYTES+1)], 3);
    const view = await recoverViewport({runId:'run',sessionId:'session',initialIndex:1,run,readHead:head});
    expect(view.replace).toBe(false); expect(view.resumeIndex).toBe(3); expect(view.gap).toBe(true);
  });
  it('shares the 5s optional deadline and uses H0 when final metadata probe hangs', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const run: ViewportRunReader = {status:async()=> 'running',nextIndex:vi.fn(()=>new Promise<number>(()=>{})),open:()=>new ReadableStream({cancel})};
    const promise = recoverViewport({runId:'run',sessionId:'session',initialIndex:7,run,readHead:()=>new Promise(()=>{})});
    await vi.advanceTimersByTimeAsync(VIEWPORT_RECOVERY_MAX_MS + VIEWPORT_FINAL_PROBE_MAX_MS);
    const view = await promise;
    expect(view.resumeIndex).toBe(7); expect(view.replace).toBe(false); expect(cancel).toHaveBeenCalledOnce();
    expect(run.nextIndex).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('abort releases pending sample and never probes live tail afterward', async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const run: ViewportRunReader = {status:async()=> 'running',nextIndex:vi.fn(async()=>4),open:()=>new ReadableStream({cancel})};
    const promise = recoverViewport({runId:'run',sessionId:'session',initialIndex:3,run,readHead:head,signal:controller.signal});
    controller.abort(); await expect(promise).rejects.toThrow('aborted');
    expect(cancel).toHaveBeenCalledOnce(); expect(run.nextIndex).not.toHaveBeenCalled();
  });
  it('malformed/empty/early EOF are best effort, not a retry loop', async () => {
    const run = runWith(['bad frame'], 5);
    const view = await recoverViewport({runId:'run',sessionId:'session',initialIndex:4,run,readHead:head});
    expect(view.resumeIndex).toBe(5); expect(view.replace).toBe(false); expect(run.open).toHaveBeenCalledOnce();
  });
});
