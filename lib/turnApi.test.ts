/**
 * Plan #811 (D17) — host client for POST /api/turns.
 * Adversarial-review Major (L6): the durable-turn transport is the production
 * default (`runHarnessTurn` wires `sendTurn`/`sendTurnStream`), so these rows
 * exercise the real client against a stubbed global fetch — header capture,
 * `sessionId`/`personaId`/`cwd` on the body, JSON 4xx, SSE success + failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTurn, sendTurnStream } from './turnApi';

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
