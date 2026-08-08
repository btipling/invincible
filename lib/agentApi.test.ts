import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_NOT_CONFIGURED_ERROR, sendAgent, sendAgentStream } from './agentApi';
import { AUTH_REQUIRED_ERROR, SANDBOX_FORBIDDEN_ERROR } from './tenancy/errors';

describe('sendAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses success with toolTrace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          text: 'done',
          toolTrace: [{ name: 'list_dir', ok: true, summary: 'list_dir . → 0' }],
        }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result).toEqual({
      ok: true,
      text: 'done',
      toolTrace: [{ name: 'list_dir', ok: true, summary: 'list_dir . → 0' }],
    });
  });

  it('marks sandboxNotConfigured only on 503 + exact string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: SANDBOX_NOT_CONFIGURED_ERROR },
          { status: 503 },
        ),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sandboxNotConfigured).toBe(true);
      expect(result.status).toBe(503);
      expect(result.error).toBe(SANDBOX_NOT_CONFIGURED_ERROR);
    }
  });

  it('does not mark sandboxNotConfigured on 503 with other body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'Upstream overloaded' }, { status: 503 }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sandboxNotConfigured).toBeUndefined();
      expect(result.error).toBe('Upstream overloaded');
    }
  });

  it('returns cancelled on abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new DOMException('Aborted', 'AbortError');
        throw err;
      }),
    );
    const result = await sendAgent('hi');
    expect(result).toEqual({ ok: false, error: 'Request cancelled.' });
  });

  it('does not mark sandboxNotConfigured on 401 auth required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe(AUTH_REQUIRED_ERROR);
      expect(result.sandboxNotConfigured).toBeUndefined();
    }
  });


  it('does not mark sandboxNotConfigured on 403 sandbox forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: SANDBOX_FORBIDDEN_ERROR }, { status: 403 }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toBe(SANDBOX_FORBIDDEN_ERROR);
      expect(result.sandboxNotConfigured).toBeUndefined();
    }
  });


});


describe('sendAgentStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseResponse(chunks: string[], init?: ResponseInit): Response {
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
        ...(init?.headers as Record<string, string> | undefined),
      },
      ...init,
    });
  }

  it('parses tool + text events and returns done text', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"tool_start","name":"list_dir"}\n\n',
          'data: {"type":"tool_result","name":"list_dir","ok":true,"summary":"list_dir · ok · a"}\n\n',
          'data: {"type":"text_delta","text":"Hi"}\n\n',
          'data: {"type":"text_delta","text":" there"}\n\n',
          'data: {"type":"done","text":"Hi there","toolTrace":[{"name":"list_dir","ok":true,"summary":"list_dir · ok · a"}]}\n\n',
        ]),
      ),
    );
    const result = await sendAgentStream('list', {
      onEvent: async (ev) => {
        events.push(ev.type);
      },
    });
    expect(result).toEqual({
      ok: true,
      text: 'Hi there',
      toolTrace: [{ name: 'list_dir', ok: true, summary: 'list_dir · ok · a' }],
    });
    expect(events).toEqual([
      'tool_start',
      'tool_result',
      'text_delta',
      'text_delta',
      'done',
    ]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      }),
    );
  });

  it('accepts CRLF-framed SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"text_delta","text":"A"}\r\n\r\n',
          'data: {"type":"done","text":"A"}\r\n\r\n',
        ]),
      ),
    );
    const result = await sendAgentStream('x');
    expect(result).toEqual({ ok: true, text: 'A' });
  });

  it('keeps delta text when done.text is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"text_delta","text":"partial"}\n\n',
          'data: {"type":"done","text":""}\n\n',
        ]),
      ),
    );
    const result = await sendAgentStream('x');
    expect(result).toEqual({ ok: true, text: 'partial' });
  });

  it('returns stream error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"error","error":"boom","status":502}\n\n',
        ]),
      ),
    );
    const result = await sendAgentStream('x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('boom');
      expect(result.status).toBe(502);
    }
  });

  it('parses early JSON 503 sandbox-not-configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: SANDBOX_NOT_CONFIGURED_ERROR },
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await sendAgentStream('x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sandboxNotConfigured).toBe(true);
      expect(result.status).toBe(503);
    }
  });
});
