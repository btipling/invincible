import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newBlobObjectId } from '../../../../../lib/sessions/blobStore';
const mocks=vi.hoisted(()=>({auth:vi.fn(),tenant:vi.fn(),store:vi.fn(),envelope:vi.fn(),read:vi.fn()}));
vi.mock('../../../../../lib/tenancy/session',()=>({requireSessionUser:mocks.auth}));
vi.mock('../../../../../lib/di',()=>({createProdServices:()=>({harnessSessionsRedis:{resolveTenantIdForUser:mocks.tenant},createBlobTranscriptStore:()=>({read:mocks.read})})}));
vi.mock('../../../../../lib/tenancy/harnessSessionsRedis',()=>({resolveSessionStore:mocks.store,sessionKeyFor:(tenantId:string,userId:string,sessionId:string)=>({tenantId,userId,sessionId})}));
vi.mock('../../../../../lib/sessions/sessionStore',()=>({isEnvelopeStore:()=>true}));
import {GET} from './route';
const scope={tenantId:'t',userId:'u',sessionId:'s'};
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({ok:true,user:{id:'u'}});mocks.tenant.mockResolvedValue({ok:true,value:'t'});
  mocks.store.mockResolvedValue({ok:true,value:{readEnvelope:mocks.envelope}});
  mocks.envelope.mockResolvedValue({meta:{transcriptPointer:newBlobObjectId(scope),turnRunId:'run',workingNotes:'secret notes',personaSnapshot:'secret persona'}});
  mocks.read.mockResolvedValue(JSON.stringify({id:'s',prev:newBlobObjectId(scope),messages:[{role:'assistant',text:'recent'}],queue:['next']}));});
const request=(query='')=>GET(new Request(`https://example.com/api/sessions/s/viewport${query}`),{params:Promise.resolve({id:'s'})});
describe('head-only view route',()=>{
  it('reads one head and safe carriers, no private meta or write surface',async()=>{
    const res=await request();expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toContain('private');
    const body=await res.json();expect(body).toMatchObject({historyComplete:false,replace:true,hasEarlier:true,rows:[{text:'recent'}],carriers:{queue:['next']}});
    expect(JSON.stringify(body)).not.toContain('secret');expect(mocks.read).toHaveBeenCalledOnce();
  });
  it('corrupt/missing head retains cached paint',async()=>{
    for(const raw of [null,'invalid',JSON.stringify({id:'wrong',messages:[]})]){mocks.read.mockResolvedValue(raw);expect(await (await request()).json()).toMatchObject({replace:false,source:'unavailable'});}
  });
  it('auth/ownership run mismatch before body access; unknown page params rejected until phase4',async()=>{
    mocks.auth.mockResolvedValue({ok:false,response:Response.json({}, {status:401})});expect((await request()).status).toBe(401);
    mocks.auth.mockResolvedValue({ok:true,user:{id:'u'}});expect((await request('?runId=foreign')).status).toBe(404);
    expect((await request('?objectId=anything')).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();
  });
  it('foreign planted pointer is not read and missing store fails closed',async()=>{
    mocks.envelope.mockResolvedValue({meta:{transcriptPointer:newBlobObjectId({...scope,userId:'foreign'})}});
    expect(await (await request()).json()).toMatchObject({replace:false});expect(mocks.read).not.toHaveBeenCalled();
    mocks.store.mockResolvedValue({ok:false});expect((await request()).status).toBe(503);
  });
});
