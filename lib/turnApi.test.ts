/**
 * Plan #811 (D17) — host client for POST /api/turns.
 * Adversarial-review Major (L6): the durable-turn transport is the production
 * default (`runHarnessTurn` wires `sendTurn`/`sendTurnStream`), so these rows
 * exercise the real client against a stubbed global fetch — header capture,
 * `sessionId`/`personaId`/`cwd` on the body, JSON 4xx, SSE success + failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTurnStream, sendTurn, sendTurnStream } from './turnApi';

function sseResponse(chunks: string[], header?: { 'x-workflow-run-id': string }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      ...(header ?? {}),
    },
  });
}

describe('sendTurn (JSON path)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the JSON body with sessionId/personaId/cwd and blends x-workflow-run-id header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.prompt).toBe('list');
      expect(body.sessionId).toBe('s_realtime_persona');
      expect(body.personaId).toBe('p_x');
      expect(body.cwd).toBe('app');
      expect(body).not.toHaveProperty('runId'); // C14b: runId is never a start() arg
      return new Response(JSON.stringify({ text: 'done', toolTrace: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-workflow-run-id': 'wr_0000_realtime',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendTurn('list', {
      sessionId: 's_realtime_persona',
      personaId: 'p_x',
      cwd: 'app',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('done');
      expect((result as { turnRunId?: string }).turnRunId).toBe('wr_0000_realtime');
    }
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/turns',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('JSON 4xx (missing sessionId) → ok:false with status + error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'sessionId is required', code: 'VALIDATION' },
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await sendTurn('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/sessionId is required/);
    }
  });

  it('non-JSON non-ok response falls back to text error with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Bad Gateway upstream', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    );
    const result = await sendTurn('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe('Bad Gateway upstream');
    }
  });

  it('abort returns Request cancelled.', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const result = await sendTurn('hi', { signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Request cancelled.');
  });
});

describe('sendTurnStream (SSE path — production default)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams SSE events, requires Accept, blends run header + warning', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body.sessionId).toBe('s_stream');
      return sseResponse(
        [
          'data: {"type":"tool_start","name":"list_dir"}\n\n',
          'data: {"type":"tool_result","name":"list_dir","ok":true,"summary":"list_dir · ok"}\n\n',
          'data: {"type":"text_delta","text":"Hi"}\n\n',
          'data: {"type":"done","text":"Hi there","toolTrace":[{"name":"list_dir","ok":true,"summary":"list_dir · ok"}]}\n\n',
        ],
        { 'x-workflow-run-id': 'wr_0000_stream' },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const started: string[] = [];
    const result = await sendTurnStream('list', {
      sessionId: 's_stream',
      onTurnStarted: ({ turnRunId }) => {
        started.push(turnRunId);
      },
    });
    expect(started).toEqual(['wr_0000_stream']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('Hi there');
      expect(result.toolTrace).toEqual([
        { name: 'list_dir', ok: true, summary: 'list_dir · ok' },
      ]);
      expect((result as { turnRunId?: string }).turnRunId).toBe('wr_0000_stream');
    }
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/turns',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      }),
    );
  });

  it('early JSON 400 → ok:false with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'run already open (C15 live-lock)', code: 'LIVE_LOCK' },
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/already open/);
    }
  });

  it('SSE error event → ok:false with status + run header blend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          ['data: {"type":"error","error":"boom","status":502}\n\n'],
          { 'x-workflow-run-id': 'wr_0000_err' },
        ),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe('boom');
      expect(result.turnRunId).toBe('wr_0000_err');
    }
  });

  it('SSE done + finishReason length → ok:false output truncated (parser defense)', async () => {
    const types: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          [
            'data: {"type":"text_delta","text":"cut off mid"}\n\n',
            'data: {"type":"done","text":"cut off mid","finishReason":"length"}\n\n',
          ],
          { 'x-workflow-run-id': 'wr_trunc' },
        ),
      ),
    );
    const result = await sendTurnStream('hi', {
      onEvent: async (ev) => {
        types.push(ev.type);
      },
    });
    expect(types).toEqual(['text_delta', 'done']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('output truncated');
      expect(result.turnRunId).toBe('wr_trunc');
    }
  });

  it('truncated done without trailing blank line still errors (flush parse site)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          ['data: {"type":"done","text":"cut","finishReason":"content-filter"}'],
          { 'x-workflow-run-id': 'wr_flush' },
        ),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('content filtered');
  });

  it('SSE done + finishReason error → ok:false model error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          [
            'data: {"type":"text_delta","text":"thinking painted"}\n\n',
            'data: {"type":"done","text":"thinking painted","finishReason":"error"}\n\n',
          ],
          { 'x-workflow-run-id': 'wr_err' },
        ),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('model error');
      expect(result.error).not.toBe('output truncated');
      expect(result.turnRunId).toBe('wr_err');
    }
  });

  it('SSE done + finishReason stop stays ok:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          ['data: {"type":"done","text":"hi","finishReason":"stop"}\n\n'],
          { 'x-workflow-run-id': 'wr_stop' },
        ),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('hi');
  });

  it('fail-closed to plain failure when res.body is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(undefined, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    const result = await sendTurnStream('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Empty stream body/);
  });

  it('abort before headers omits turnRunId (adversarial #844)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const result = await sendTurnStream('hi', { signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Request cancelled.');
      expect(result.turnRunId).toBeUndefined();
    }
  });

  it('abort after headers carries the parsed turnRunId (adversarial #844)', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller.abort();
            c.error(new DOMException('aborted', 'AbortError'));
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'x-workflow-run-id': 'wr_live',
            'x-workflow-run-warning': 'note',
          },
        });
      }),
    );
    const started: string[] = [];
    const result = await sendTurnStream('hi', {
      signal: controller.signal,
      onTurnStarted: ({ turnRunId }) => {
        started.push(turnRunId);
      },
    });
    expect(started).toEqual(['wr_live']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Request cancelled.');
      expect(result.turnRunId).toBe('wr_live');
      expect(result.turnWarning).toBe('note');
    }
  });

  it('non-abort stream-read throw still returns turnRunId (plan #852)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.error(new TypeError('network dropped'));
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'x-workflow-run-id': 'wr_live',
            'x-workflow-run-warning': 'note',
          },
        });
      }),
    );
    const started: string[] = [];
    const result = await sendTurnStream('hi', {
      onTurnStarted: ({ turnRunId }) => {
        started.push(turnRunId);
      },
    });
    expect(started).toEqual(['wr_live']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/network dropped/);
      expect(result.turnRunId).toBe('wr_live');
      expect(result.turnWarning).toBe('note');
    }
  });
});

describe('attachTurnStream (GET attach — plan #813 E19)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/turns/:runId/stream?sessionId=&startIndex= and dispatches onEvent', async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(String(url)).toBe(
        '/api/turns/wr_attach/stream?sessionId=s_tab&startIndex=0',
      );
      expect((init?.headers as Record<string, string>).Accept).toBe(
        'text/event-stream',
      );
      return sseResponse(
        [
          'data: {"type":"reasoning_delta","text":"hmm"}\n\n',
          'data: {"type":"text_delta","text":"Hi"}\n\n',
          'data: {"type":"done","text":"Hi"}\n\n',
        ],
        { 'x-workflow-run-id': 'wr_attach' },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const started: string[] = [];
    const result = await attachTurnStream('wr_attach', {
      sessionId: 's_tab',
      startIndex: 0,
      onTurnStarted: ({ turnRunId }) => {
        started.push(turnRunId);
      },
      onEvent: async (ev) => {
        events.push(ev.type);
      },
    });
    expect(started).toEqual(['wr_attach']);
    expect(events).toEqual(['reasoning_delta', 'text_delta', 'done']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('Hi');
  });

  it('hot resume passes startIndex=C on the query string', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('startIndex=42');
      expect(String(url)).toContain('sessionId=s_hot');
      return sseResponse(
        ['data: {"type":"text_delta","text":"tail"}\n\n', 'data: {"type":"done","text":"tail"}\n\n'],
        { 'x-workflow-run-id': 'wr_hot' },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await attachTurnStream('wr_hot', {
      sessionId: 's_hot',
      startIndex: 42,
    });
    expect(result.ok).toBe(true);
  });

  it('abort closes this reader only — GET, no cancel POST', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await attachTurnStream('wr_1', {
      sessionId: 's_1',
      startIndex: 0,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Request cancelled.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/stream?');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('JSON 404 is a failure and does not fire onTurnStarted', async () => {
    const started: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Run not found: wr_gone' },
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await attachTurnStream('wr_gone', {
      sessionId: 's_1',
      startIndex: 0,
      onTurnStarted: ({ turnRunId }) => {
        started.push(turnRunId);
      },
    });
    expect(started).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toMatch(/Run not found/);
    }
  });

  it('JSON 503 is a failure (store unavailable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Unable to attach to run stream (store unavailable).' },
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await attachTurnStream('wr_1', {
      sessionId: 's_1',
      startIndex: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('empty done.text on attach is ok (thinking-only / all-dedup)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(
          [
            'data: {"type":"reasoning_delta","text":"think"}\n\n',
            'data: {"type":"done","text":""}\n\n',
          ],
          { 'x-workflow-run-id': 'wr_think' },
        ),
      ),
    );
    const result = await attachTurnStream('wr_think', {
      sessionId: 's_1',
      startIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('');
  });

  it('invalid startIndex / sessionId fail closed before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const badIndex = await attachTurnStream('wr_1', {
      sessionId: 's_1',
      startIndex: -1,
    });
    expect(badIndex.ok).toBe(false);
    if (!badIndex.ok) expect(badIndex.status).toBe(400);
    const badSession = await attachTurnStream('wr_1', {
      sessionId: 'not opaque!',
      startIndex: 0,
    });
    expect(badSession.ok).toBe(false);
    if (!badSession.ok) expect(badSession.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
