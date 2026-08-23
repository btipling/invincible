import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../../../lib/sessions/memorySessionStore';
import { setSessionStoreForTests } from '../../../lib/tenancy/harnessSessionsRedis';
import { AGENT_STREAM_CONTENT_TYPE } from '../../../lib/agent/agentStream';

/**
 * backend-agents E (#791 / source #768): unit tests for the REAL POST /api/turns
 * start surface. The route starts the durable `turnWorkflow` (via `runTurnWorkflow`
 * — the production start-able facade); here `workflow/api` (`start`) is mocked so no
 * real Workflow runs. Mocks the session + tenant seams the route uses to persist
 * `meta.turnRunId`/`turnStatus` BEFORE returning.
 *
 * Covers plan test rows 8/9/10:
 *   8  accepts agent body (sessionId required), persists turnRunId/turnStatus on the
 *      envelope, starts the workflow → 200 { runId } + x-workflow-run-id (SSE when
 *      the client asked for a stream).
 *   9  unauthed → 401; Workflows-disabled `start` → 503 fail-closed; a second start
 *      within the per-process window → 429, and a live `meta.turnRunId` on the
 *      session → 409 duplicate-guard (never a second concurrent run).
 *  10  Step Function pins `export const maxDuration = 1800` (source-read assert).
 *  no-/api/agent fallback source lock (the #710 lie is not re-introduced).
 */

const ROUTE_SOURCE = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

/** A valid agent body for the durable start surface (`sessionId` required). */
const AGENT_BODY = JSON.stringify({ prompt: 'write the plan', sessionId: 'sess-1', cwd: '.' });

/** Read a session envelope back through the DI override the route wrote to. */
async function readEnv(key: { tenantId: string; userId: string; sessionId: string }) {
  const { resolveSessionStore } = await import(
    '../../../lib/tenancy/harnessSessionsRedis'
  );
  const res = await resolveSessionStore();
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = res.value as any;
  return store.readEnvelope ? store.readEnvelope(key) : null;
}

function startResult(runId = 'turn_run_1') {
  return {
    runId,
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
        c.close();
      },
    }),
  };
}

describe('POST /api/turns (real start surface)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Inject a fresh in-memory envelope store for the next route import
    // (resolveSessionStore reads this override).
    setSessionStoreForTests(new MemorySessionStore());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/di');
    setSessionStoreForTests(null);
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

  /** Seed the DI tenant resolver the route consumes via createProdServices(). */
  function mockTenant(
    input:
      | { ok: true; tenantId: string }
      | { ok: false; code?: string; error?: string },
  ) {
    const result = input.ok
      ? { ok: true as const, value: input.tenantId }
      : {
          ok: false as const,
          code: input.code ?? 'SESSION_STORE_UNAVAILABLE',
          error: input.error ?? 'tenant membership lookup failed',
        };
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: { resolveTenantIdForUser: vi.fn(async () => result) },
      }),
      createScriptConnection: vi.fn(),
    }));
  }

  function mockWorkflowApi(
    opts: { start?: (...args: unknown[]) => Promise<ReturnType<typeof startResult>> } = {},
  ) {
    const start = opts.start ?? (async () => startResult());
    vi.doMock('workflow/api', () => ({ start }));
  }

  it('unauthenticated → 401 (auth gate wins before body parse / start)', async () => {
    vi.resetModules();
    mockSession({
      ok: false,
      response: Response.json({ error: 'Authentication required.' }, { status: 401 }),
    });
    mockTenant({ ok: true, tenantId: 't1' });
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns', { method: 'POST', body: AGENT_BODY }));
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockTenant({ ok: true, tenantId: 't1' });
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/turns', { method: 'POST', body: AGENT_BODY }));
    expect(res.status).toBe(401);
  });

  it('start success → 200 { runId } + x-workflow-run-id; persists turnRunId/turnStatus on the envelope', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    const startSpy = vi.fn(async () => startResult());
    mockWorkflowApi({ start: startSpy });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        headers: { accept: 'application/json' },
        body: AGENT_BODY,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('turn_run_1');
    await expect(res.json()).resolves.toEqual({ runId: 'turn_run_1' });

    // The route started the DURABLE workflow (runTurnWorkflow), not the B fixture.
    expect(startSpy).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call0: any = startSpy.mock.calls[0];
    expect(typeof call0?.[0]).toBe('function');
    expect(Array.isArray(call0?.[1])).toBe(true);

    // Carrier persisted BEFORE returning on the session envelope (turnRunId live).
    const envelope = await readEnv({ tenantId: 't1', userId: 'u1', sessionId: 'sess-1' });
    expect(envelope?.meta?.turnRunId).toBe('turn_run_1');
    expect(envelope?.meta?.turnStatus).toBe('running');
  });

  it('Accept: text/event-stream → 200 SSE pipe (run.readable) with the agent Content-Type', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    mockWorkflowApi();
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: AGENT_BODY,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('turn_run_1');
    expect(res.headers.get('content-type')).toContain(AGENT_STREAM_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('"type":"done"');
  });

  it('missing sessionId → 400 (the worker must bind to a session)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    const startSpy = vi.fn(async () => startResult());
    mockWorkflowApi({ start: startSpy });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('start throws (Workflows disabled) → 503 fail-closed, clear error, no /api/agent fallback', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    mockWorkflowApi({
      start: async () => {
        throw new Error('Workflow feature is not enabled for this project.');
      },
    });
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', { method: 'POST', body: AGENT_BODY }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/fail closed/i);
  });

  it('a second POST within the per-process window → 429 (start not called again)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    const startSpy = vi.fn(async () => startResult('turn_run_2'));
    mockWorkflowApi({ start: startSpy });
    const { POST } = await import('./route');
    // Bypass the duplicate-guard (no pre-existing turnRunId in THIS store for the
    // second session id) but stay inside the 15s interval window.
    await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'sess-A', prompt: 'p' }),
      }),
    ).then((r) => expect(r.status).toBe(200));
    const second = await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'sess-B', prompt: 'p2' }),
      }),
    );
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toMatch(/rate limit/i);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('live meta.turnRunId on the session → 409 duplicate-guard (never a second run)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    const startSpy = vi.fn(async () => startResult());
    mockWorkflowApi({ start: startSpy });
    // Seed a live turnRunId BEFORE the route import so the first POST hits the guard.
    const store = new MemorySessionStore();
    await store.upsertEnvelope(
      { tenantId: 't1', userId: 'u1', sessionId: 'sess-1' },
      { id: 'sess-1', tenantId: 't1', userId: 'u1', updatedAt: Date.now(), meta: { turnRunId: 'live-run' } },
    );
    setSessionStoreForTests(store);
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://x/api/turns', { method: 'POST', body: AGENT_BODY }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.turnRunId).toBe('live-run');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('a 409 duplicate does NOT consume the per-process start window (adversary Minor #5)', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockTenant({ ok: true, tenantId: 't1' });
    const startSpy = vi.fn(async () => startResult());
    mockWorkflowApi({ start: startSpy });
    // Seed a live turnRunId for sess-1 so THAT POST 409s (a duplicate — NOT a
    // start, so it must NOT advance the window clock).
    const store = new MemorySessionStore();
    await store.upsertEnvelope(
      { tenantId: 't1', userId: 'u1', sessionId: 'sess-1' },
      { id: 'sess-1', tenantId: 't1', userId: 'u1', updatedAt: Date.now(), meta: { turnRunId: 'live-run' } },
    );
    setSessionStoreForTests(store);
    const { POST } = await import('./route');
    const dup = await POST(
      new Request('https://x/api/turns', { method: 'POST', body: AGENT_BODY }),
    );
    expect(dup.status).toBe(409);
    // Same isolate, immediately: a DIFFERENT session (no carrier) must be allowed
    // to start — the 409 did NOT burn the window (start clock untouched).
    const fresh = await POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'sess-2', prompt: 'p2' }),
      }),
    );
    expect(fresh.status).toBe(200);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe('step Function maxDuration + fail-closed no-/api/agent fallback', () => {
  it('pins maxDuration = 1800 on the step start surface (plan row 10)', () => {
    expect(ROUTE_SOURCE).toMatch(/export const maxDuration\s*=\s*1800/);
  });

  it('route has no tab-owned /api/agent fallback path (the #710 lie)', () => {
    // The route MAY import the event contract (`lib/agent/agentStream` for
    // AGENT_STREAM_CONTENT_TYPE / wantsAgentStream). The fallback ban is on any
    // dynamic fetch / import of the PRODUCTION turn-owner route `app/api/agent`.
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
