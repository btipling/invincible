import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_STREAM_CONTENT_TYPE } from '../../../lib/agent/agentStream';

/**
 * backend-agents B spike (plan #787): unit tests for POST /api/turns. Mocks
 * `workflow/api` (`start`) — the route never starts a real Workflow here.
 * Covers the fail-closed contract: 401 unauth, 503 on a Workflows-disabled
 * `start`, `x-workflow-run-id` header + `{ runId }`, optional SSE pipe when the
 * client asked for a stream, and the deterministic no-`/api/agent`-fallback
 * source lock (plan goal 2 / #710 lie).
 */

const ROUTE_SOURCE = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

describe('POST /api/turns', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/workflows/turnsFixtureWorkflow');
  });

  function mockSession(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => result),
    }));
  }

  function mockWorkflowApi(
    opts: { start?: (...args: unknown[]) => Promise<{ runId: string; readable: ReadableStream }> } = {},
  ) {
    const start =
      opts.start ??
      (async () => ({
        runId: 'turns_run_1',
        readable: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
            c.close();
          },
        }),
      }));
    vi.doMock('workflow/api', () => ({ start }));
  }

  function mockFixture() {
    vi.doMock('../../../lib/workflows/turnsFixtureWorkflow', () => ({
      turnsFixtureWorkflow: vi.fn(async () => ({ status: 'completed' })),
    }));
  }

  it('unauthenticated → 401', async () => {
    vi.resetModules();
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockFixture();
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns'));
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockFixture();
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns'));
    expect(res.status).toBe(401);
  });

  it('start success → 200 { runId } + x-workflow-run-id header (no stream)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns', { headers: { accept: 'application/json' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('turns_run_1');
    await expect(res.json()).resolves.toEqual({ runId: 'turns_run_1' });
  });

  it('Accept: text/event-stream → 200 SSE pipe (run.readable) with the agent Content-Type', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', { headers: { accept: 'text/event-stream' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('turns_run_1');
    expect(res.headers.get('content-type')).toContain(AGENT_STREAM_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('"type":"done"');
  });

  it('start throws (Workflows disabled) → 503 fail-closed, clear error', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({
      start: async () => {
        throw new Error('Workflow feature is not enabled for this project.');
      },
    });
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Vercel Workflows turns spike failed/i);
  });
});

describe('fail-closed no-/api/agent fallback (plan #787 / #710 lie)', () => {
  it('route has no tab-owned /api/agent fallback path', () => {
    // The route MAY import the event contract (`lib/agent/agentStream` for
    // AGENT_STREAM_CONTENT_TYPE / wantsAgentStream — plan #787 reuses it). The
    // fallback ban is on the PRODUCTION turn-owner ROUTE `app/api/agent` and any
    // dynamic fetch to `/api/agent` (the #710 lie).
    const importSpecifiers = [
      ...ROUTE_SOURCE.matchAll(/(?:from\s+|import\()['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    expect(
      importSpecifiers.some(
        (s) => /app\/api\/agent/.test(s) || /\.\.?\/agent(?:\/|["']|$)/.test(s),
      ),
    ).toBe(false);
    expect(ROUTE_SOURCE).toContain('status: 503');
    expect(ROUTE_SOURCE).not.toMatch(/fetch\(\s*[`"']/);
    expect(ROUTE_SOURCE).not.toMatch(/fetch\([^)]*\/api\/agent/i);
  });
});
