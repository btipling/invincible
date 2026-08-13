import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAgent, sendAgentStream } from './agentApi';
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

  it('parses success preserving the TYPED change_dir cwd in toolTrace (adversarial review #470)', async () => {
    const LONG_PATH =
      'packages/frontend/src/components/settings/panels/advanced/billing/extra';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          text: 'moved',
          toolTrace: [
            {
              name: 'change_dir',
              ok: true,
              summary: `change_dir · ✓ ok · ${LONG_PATH.slice(0, 60)} · cwd=…`,
              cwd: LONG_PATH,
            },
          ],
        }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolTrace?.[0]?.cwd).toBe(LONG_PATH);
      // The display summary is truncated, the typed field is not.
      expect(result.toolTrace?.[0]?.summary).toContain('…');
    }
  });

  it('returns 503 failure as a plain error (no sandboxNotConfigured special case)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.' },
          { status: 503 },
        ),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/Sandbox not configured/);
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

  it('returns 401 auth required as a plain error', async () => {
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
    }
  });

  it('returns 403 sandbox forbidden as a plain error', async () => {
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

  it('parses early JSON 503 as a plain failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.' },
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const result = await sendAgentStream('x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toMatch(/Sandbox not configured/);
    }
  });
});

describe('sendAgent cwd', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes cwd in JSON body when set', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        prompt?: string;
        cwd?: string;
      };
      expect(body.cwd).toBe('invincible');
      return Response.json({ text: 'ok', cwd: 'invincible' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendAgent('hi', { cwd: 'invincible' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cwd).toBe('invincible');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('omits cwd from body when unset', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(body).not.toHaveProperty('cwd');
      return Response.json({ text: 'ok' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await sendAgent('hi');
  });

  it('parses cwd from stream done event', async () => {
    const sse =
      'data: {"type":"text_delta","text":"hi"}\n\n' +
      'data: {"type":"done","text":"hi","cwd":"proj"}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(sse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    const result = await sendAgentStream('x', { cwd: 'proj' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('hi');
      expect(result.cwd).toBe('proj');
    }
  });
});

