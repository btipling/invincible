import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newBlobObjectId } from '../../../../../lib/sessions/blobStore';
import { ViewportStreamDecoder, type ViewportRecord } from '../../../../../lib/viewportStreamProtocol';
const mocks=vi.hoisted(()=>({auth:vi.fn(),tenant:vi.fn(),store:vi.fn(),getRun:vi.fn(),read:vi.fn(),envelope:vi.fn()}));
vi.mock('workflow/api',()=>({getRun:mocks.getRun}));
vi.mock('../../../../../lib/tenancy/session',()=>({requireSessionUser:mocks.auth}));
vi.mock('../../../../../lib/di',()=>({createProdServices:()=>({harnessSessionsRedis:{resolveTenantIdForUser:mocks.tenant},createBlobTranscriptStore:()=>({read:mocks.read})})}));
vi.mock('../../../../../lib/tenancy/harnessSessionsRedis',()=>({resolveSessionStore:mocks.store,sessionKeyFor:(tenantId:string,userId:string,sessionId:string)=>({tenantId,userId,sessionId})}));
vi.mock('../../../../../lib/sessions/sessionStore',()=>({isEnvelopeStore:()=>true}));
import { GET } from './route';
const scope={tenantId:'t1',userId:'u1',sessionId:'s1'};
const line=(event:object)=>`data: ${JSON.stringify(event)}\n\n`;
let open:ReturnType<typeof vi.fn>, cancel:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ok:true,user:{id:'u1'}});mocks.tenant.mockResolvedValue({ok:true,value:'t1'});
  mocks.store.mockResolvedValue({ok:true,value:{readEnvelope:mocks.envelope}});
  mocks.envelope.mockResolvedValue({meta:{turnRunId:'run',turnStatus:'cancelling',transcriptPointer:newBlobObjectId(scope)}});
  mocks.read.mockResolvedValue(JSON.stringify({id:'s1',messages:[{role:'assistant',text:'head'}]}));
  cancel=vi.fn();
  open=vi.fn((opts?:{startIndex?:number})=>Object.assign(new ReadableStream<string>({start(c){
    if(opts?.startIndex===0){c.enqueue(line({type:'reasoning_delta',text:'old-thinking'}));c.enqueue(line({type:'text_delta',text:'recent'}));c.close();}
    else if(opts?.startIndex===2){c.enqueue(line({type:'reasoning_delta',text:'new-thinking'}));c.enqueue(line({type:'done',text:'done'}));c.close();}
  },cancel}),{getTailIndex:async()=>1}));
  mocks.getRun.mockReturnValue({exists:Promise.resolve(true),status:Promise.resolve('running'),getReadable:open});
});
afterEach(()=>vi.useRealTimers());
const request=(query='sessionId=s1&viewportVersion=1&hydrate=tail')=>GET(new Request(`https://example.com/api/turns/run/stream?${query}`),{params:Promise.resolve({runId:'run'})});
async function decode(res:Response,initial?:number){const parser=new ViewportStreamDecoder('run',initial), out:ViewportRecord[]=[]; const reader=res.body!.getReader();for(;;){const r=await reader.read();if(r.done)break;out.push(...parser.push(r.value));}parser.push(new Uint8Array(),true);return out;}
describe('negotiated route uses real bounded service/codec',()=>{
  it('authorizes, samples, returns cancelling state and snapshot, then new live reasoning',async()=>{
    const res=await request();expect(res.status).toBe(200);expect(res.headers.get('x-viewport-version')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform');
    const records=await decode(res);expect(records[0]).toMatchObject({type:'viewport_state',status:'cancelling'});
    expect(records[1]).toMatchObject({type:'viewport_snapshot',resumeIndex:2,source:'stream_tail'});
    expect(JSON.stringify(records)).not.toContain('old-thinking');expect(JSON.stringify(records)).toContain('new-thinking');
    expect(mocks.read).toHaveBeenCalledOnce();expect(mocks.envelope).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith({startIndex:-1});
  });
  it('negotiated hot attach never probes head or tail',async()=>{
    const records=await decode(await request('sessionId=s1&viewportVersion=1&startIndex=2'),2);
    expect(records[0]).toMatchObject({type:'turn_event',nextIndex:3});
    expect(mocks.read).not.toHaveBeenCalled();expect(open).toHaveBeenCalledExactlyOnceWith({startIndex:2});
  });
  it.each(['sessionId=s1&viewportVersion=2','sessionId=s1&viewportVersion=1','sessionId=s1&viewportVersion=1&hydrate=tail&startIndex=0','sessionId=s1&viewportVersion=1&startIndex=1e2','sessionId=s1&sessionId=s2&viewportVersion=1'])('rejects bad negotiation before SDK access: %s',async q=>{
    expect((await request(q)).status).toBe(400);expect(mocks.getRun).not.toHaveBeenCalled();
  });
  it('unauth and foreign run never reach SDK/Blob',async()=>{
    mocks.auth.mockResolvedValue({ok:false,response:Response.json({error:'auth'},{status:401})});expect((await request()).status).toBe(401);
    mocks.auth.mockResolvedValue({ok:true,user:{id:'u1'}});mocks.envelope.mockResolvedValue({meta:{turnRunId:'foreign'}});
    expect((await request()).status).toBe(404);expect(mocks.getRun).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
  });
  it('foreign planted Blob pointer does not read it, live sample still useful',async()=>{
    mocks.envelope.mockResolvedValue({meta:{turnRunId:'run',transcriptPointer:newBlobObjectId({...scope,userId:'foreign'})}});
    const records=await decode(await request());expect(records[1]).toMatchObject({source:'stream_tail'});expect(mocks.read).not.toHaveBeenCalled();
  });
  it('missing head is a partial-history miss; revoked session before handoff is not released',async()=>{
    mocks.read.mockResolvedValue(null);mocks.envelope.mockResolvedValueOnce({meta:{turnRunId:'run'}}).mockResolvedValue(null);
    const records=await decode(await request());expect(records.map(r=>r.type)).toEqual(['viewport_state','viewport_error']);
  });
  it('does not expose SDK failure details in negotiated pre-stream errors', async () => {
    mocks.getRun.mockImplementation(() => { throw new Error('provider URL/token-private-detail'); });
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Viewport stream unavailable.' });
    expect(res.headers.get('cache-control')).toContain('private');
  });
  it('unavailable initial tail still emits recovering state and head; never origin-replays',async()=>{
    const getReadable=vi.fn(()=>new ReadableStream());
    mocks.getRun.mockReturnValue({exists:Promise.resolve(true),status:'running',getReadable});
    const res=await request();expect(res.status).toBe(200);
    const records=await decode(res);
    expect(records.map(r=>r.type)).toEqual(['viewport_state','viewport_snapshot','viewport_error']);
    expect(records[0]).toMatchObject({type:'viewport_state',phase:'recovering'});
    expect(records[1]).toMatchObject({source:'stored_head'});
    expect(JSON.stringify(records)).toContain('head');
    expect(records[2]).toMatchObject({code:'STREAM_UNAVAILABLE'});
    expect(getReadable).toHaveBeenCalledWith({startIndex:-1});
    expect(getReadable).not.toHaveBeenCalledWith({startIndex:0});
  });
  it.each(['cancelled','failed'])('%s hanging getReadable is never opened on hydrate=tail; head snapshot still ships',async status=>{
    const getReadable=vi.fn(()=>new Promise<ReadableStream<string>>(()=>{}));
    mocks.getRun.mockReturnValue({exists:Promise.resolve(true),status:Promise.resolve(status),getReadable});
    const res=await request();expect(res.status).toBe(200);
    const records=await decode(res);
    expect(getReadable).not.toHaveBeenCalled();expect(mocks.read).toHaveBeenCalledOnce();
    expect(records.map(r=>r.type)).toEqual(['viewport_state','viewport_snapshot','viewport_end']);
    expect(records[0]).toMatchObject({status});
    expect(records[1]).toMatchObject({source:'stored_head'});
    expect(JSON.stringify(records)).toContain('head');
    expect(records[2]).toMatchObject({status});
  });
  it.each(['cancelled','failed'])('%s hanging getReadable is never opened on indexed GET',async status=>{
    const getReadable=vi.fn(()=>new Promise<ReadableStream<string>>(()=>{}));
    mocks.getRun.mockReturnValue({exists:Promise.resolve(true),status:Promise.resolve(status),getReadable});
    const records=await decode(await request('sessionId=s1&viewportVersion=1&startIndex=2'),2);
    expect(getReadable).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();
    expect(records).toEqual([{type:'viewport_end',version:1,runId:'run',status}]);
  });
});
