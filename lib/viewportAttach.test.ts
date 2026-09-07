import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewportAttachTurnStream } from './viewportAttach';

function sseResponse(records: string[], viewHeader = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of records) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', ...(viewHeader ? { 'x-viewport-version': '1' } : {}) },
  });
}

describe('viewportAttachTurnStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs cold hydrate=tail (no startIndex) and folds the decoded records', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          'event: viewport_state\ndata: {"type":"viewport_state","version":1,"runId":"wr_1","phase":"recovering","status":"running"}\n\n',
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    const result = await viewportAttachTurnStream('wr_1', {
      sessionId: 's_1',
      onEvent: (rec) => { events.push(rec); },
    });
    expect(result.ok).toBe(true);
    if ('status' in result) expect(result.status).toBe(200);
    const url = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>)[0]?.[0] as RequestInfo | URL;
    expect(String(url as string).includes('viewportVersion=1&hydrate=tail')).toBe(true);
  });

  it('GETs indexed startIndex=N when explicitly supplied', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          'event: viewport_state\ndata: {"type":"viewport_state","version":1,"runId":"wr_1","phase":"recovering","status":"running"}\n\n',
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await viewportAttachTurnStream('wr_1', { sessionId: 's_1', startIndex: 7 });
    expect(result.ok).toBe(true);
    const url = (fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>)[0]?.[0] as RequestInfo | URL;
    expect(String(url as string).includes('startIndex=7')).toBe(true);
  });

  it('rejects an unknown/wrong viewportVersion (never legacy consume)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('bad', { status: 400 })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await viewportAttachTurnStream('wr_1', { sessionId: 's_1' });
    expect(result.ok).toBe(false);
    if ('status' in result) expect(result.status).toBe(400);
  });

  it('a legacy 200 SSE body without x-viewport-version is a client error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(sseResponse(['data: {"type":"done","text":"x"}'], false)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await viewportAttachTurnStream('wr_1', { sessionId: 's_1' });
    expect(result.ok).toBe(false);
    if ('error' in result) expect(result.error).toMatch(/Viewport negotiation not accepted/);
  });
});