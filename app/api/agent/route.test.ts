import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests import the handler after env is set.
 * We mock runAgent to avoid real Gateway.
 */
describe('POST /api/agent', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.unmock('../../../lib/agent/runAgent');
  });

  async function loadRoute() {
    return import('./route');
  }

  it('returns 500 when gateway key missing', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/AI_GATEWAY_API_KEY/);
  });

  it('returns 503 with exact sandbox-not-configured string', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    );
    expect(JSON.stringify(body)).not.toContain('gw-key');
  });

  it('returns 400 on bad body', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 123 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('200 returns text and never leaks secrets', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key-super-secret';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';

    vi.resetModules();
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({
        text: 'hello from agent',
        toolTrace: [
          { name: 'list_dir', ok: true, summary: 'list_dir . → 0 entries' },
        ],
      })),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('hello from agent');
    expect(body.toolTrace).toHaveLength(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sandbox-secret-token');
    expect(raw).not.toContain('gw-key-super-secret');
  });

  it('returns 499 when runAgent aborts', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';

    vi.resetModules();
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(499);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Request cancelled.');
  });
});
