import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the authed Vercel-Workflows smoke route (backend-agents D,
 * plan #785). Mocks `workflow/api` (the SDK's `start`/`getRun`) — the route
 * never runs a real Workflow run here. Covers the fail-closed contract: 401 unauth,
 * 500/400/404 guards, 503 when start/getRun throws (Workflows disabled), and the
 * deterministic no-`/api/agent`-fallback source lock (plan #785 goal 6 / #710 lie).
 */

const ROUTE_SOURCE = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

describe('POST /api/workflows/smoke', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../../lib/tenancy/session');
    vi.doUnmock('../../../../lib/workflows/fixtureWorkflow');
  });

  function mockSession(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => result),
    }));
  }

  function mockWorkflowApi(opts: {
    start?: (...args: unknown[]) => Promise<{ runId: string }>;
    getRun?: (runId: string) => {
      exists: Promise<boolean>;
      status: Promise<string>;
      returnValue: Promise<unknown>;
    };
  }) {
    const start = opts.start ?? (async () => ({ runId: 'wf_123' }));
    const getRun =
      opts.getRun ??
      (() => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('completed'),
        returnValue: Promise.resolve({ status: 'completed' }),
      }));
    vi.doMock('workflow/api', () => ({ start, getRun }));
  }

  function mockFixture() {
    vi.doMock('../../../../lib/workflows/fixtureWorkflow', () => ({
      fixtureWorkflow: vi.fn(async () => ({ status: 'completed' })),
    }));
  }

  it('unauthenticated → 401', async () => {
    vi.resetModules();
    mockSession({
      ok: false,
      response: Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      ),
    });
    mockFixture();
    mockWorkflowApi({});
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/workflows/smoke'));
    expect(res.status).toBe(401);
  });

  it('authed without user id → 401', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: '' } });
    mockFixture();
    mockWorkflowApi({});
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/workflows/smoke'));
    expect(res.status).toBe(401);
  });

  it('start success → 200 { runId }', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({});
    const { POST } = await import('./route');
    const res = await POST(new Request('https://x/api/workflows/smoke'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: 'wf_123' });
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
    const res = await POST(new Request('https://x/api/workflows/smoke'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Vercel Workflows smoke failed/i);
  });
});

describe('GET /api/workflows/smoke?runId=', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../../lib/tenancy/session');
    vi.doUnmock('../../../../lib/workflows/fixtureWorkflow');
  });

  function mockSession(
    result:
      | { ok: true; user: { id: string; email?: string } }
      | { ok: false; response: Response },
  ) {
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => result),
    }));
  }

  function mockWorkflowApi(opts: {
    getRun?: (runId: string) => {
      exists: Promise<boolean>;
      status: Promise<string>;
      returnValue: Promise<unknown>;
    };
  }) {
    const getRun =
      opts.getRun ??
      (() => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('completed'),
        returnValue: Promise.resolve({ status: 'completed' }),
      }));
    vi.doMock('workflow/api', () => ({ getRun }));
  }

  function mockFixture() {
    vi.doMock('../../../../lib/workflows/fixtureWorkflow', () => ({
      fixtureWorkflow: vi.fn(async () => ({ status: 'completed' })),
    }));
  }

  it('unauthenticated → 401', async () => {
    vi.resetModules();
    mockSession({
      ok: false,
      response: Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      ),
    });
    mockFixture();
    mockWorkflowApi({});
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke?runId=wf_1'));
    expect(res.status).toBe(401);
  });

  it('missing runId → 400', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({});
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke'));
    expect(res.status).toBe(400);
  });

  it('run not found → 404', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({
      getRun: () => ({
        exists: Promise.resolve(false),
        status: Promise.resolve('failed'),
        returnValue: Promise.resolve(null),
      }),
    });
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke?runId=missing'));
    expect(res.status).toBe(404);
  });

  it('completed run → { status, value }', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({
      getRun: () => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('completed'),
        returnValue: Promise.resolve({ status: 'completed' }),
      }),
    });
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke?runId=wf_1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'completed',
      value: { status: 'completed' },
    });
  });

  it('running run → { status } with no value yet', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({
      getRun: () => ({
        exists: Promise.resolve(true),
        status: Promise.resolve('running'),
        returnValue: Promise.resolve(null),
      }),
    });
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke?runId=wf_1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'running' });
  });

  it('getRun throws (Workflows disabled) → 503 fail-closed', async () => {
    vi.resetModules();
    mockSession({ ok: true, user: { id: 'u1', email: 'a@t.com' } });
    mockFixture();
    mockWorkflowApi({
      getRun: () => {
        throw new Error('Workflow feature is not enabled for this project.');
      },
    });
    const { GET } = await import('./route');
    const res = await GET(new Request('https://x/api/workflows/smoke?runId=wf_1'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Vercel Workflows smoke failed/i);
  });
});

describe('fail-closed no-/api/agent fallback (plan #785 goal 6 / #710 lie)', () => {
  it('route has no tab-owned /api/agent fallback path', () => {
    // Doc comments may *mention* the /api/agent lie (that is the point of the
    // warning). The invariant is that no import/authoritative-path references
    // the tab-owned agent route — the only caller-reachable surfaces are
    // workflow/api (start/getRun) and the 503 fail-closed error path.
    const importSpecifiers = [
      ...ROUTE_SOURCE.matchAll(/(?:from\s+|import\()['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    expect(importSpecifiers.some((s) => /agent/.test(s))).toBe(false);
    // The route's only reachable failure mode is the fail-closed 503.
    expect(ROUTE_SOURCE).toContain('status: 503');
  });
});
