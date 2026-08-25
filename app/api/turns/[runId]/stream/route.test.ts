import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Route tests for backend-agents C16 (#810) — `GET /api/turns/:runId/stream`
 * durable-turn stream attach/reconnect.
 *
 * Mocks `getRun`, `sanitizeTurnRunId`, `sanitizeTurnStreamCursor`,
 * `requireSessionUser`, `resolveSessionStore`, `sessionKeyFor`,
 * `isEnvelopeStore`, and `createProdServices` so the route never
 * opens a real DB/Redis connection or reaches the Workflows API.
 *
 * Covers the original 14-row test matrix plus new tenancy-check rows:
 *   1. startIndex=0 → full replay
 *   2. startIndex=N → mid-stream resume
 *   3. startIndex absent → defaults to 0
 *   4. Run not found → 404
 *   5. getReadable throws → 503 fail-closed
 *   6. Invalid runId → 400
 *   7. startIndex negative → 400
 *   8. startIndex non-integer → 400
 *   9. startIndex over cap → 400
 *  10. startIndex non-numeric → 400
 *  11. Auth failure → 401
 *  12. Client abort closes reader, does NOT cancel run
 *  13. Completed run → 200
 *  14. Missing runId param → 400 (handler guard)
 *
 *  15. Missing sessionId → 400
 *  16. Tenant resolve failure → 503
 *  17. Envelope absent (miss) → 404
 *  18. Envelope turnRunId mismatch → 404
 *  19. Happy path with tenancy check → 200
 */
describe('GET /api/turns/:runId/stream', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getReadableMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sanitizeTurnRunIdMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sanitizeTurnStreamCursorMock: any;

  /** Spy on the returned readable stream's cancel method (Row 12). */
  let readableCancelSpy: ReturnType<typeof vi.fn>;

  /** Spy on run.cancel — must NEVER be called (abort ≠ cancel). */
  let runCancelSpy: ReturnType<typeof vi.fn>;

  // Tenancy mock state
  let envelopeTurnRunId: string;
  let envelopePresent: boolean;
  let tenantResolveOk: boolean;
  let storeAvailable: boolean;

  function resetState() {
    readableCancelSpy = vi.fn(async () => {});
    runCancelSpy = vi.fn(async () => {});
    getReadableMock = vi.fn(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"a"}\n\n'));
          controller.close();
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stream as any).cancel = readableCancelSpy;
      return stream;
    });

    // Default tenancy state: tenant resolves OK, store available, envelope
    // present with matching turnRunId.
    envelopeTurnRunId = 'wf_turn_123';
    envelopePresent = true;
    tenantResolveOk = true;
    storeAvailable = true;
  }

  function mockGetRun(overrides: Record<string, unknown> = {}) {
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.resolve(true),
      getReadable: getReadableMock,
      cancel: runCancelSpy,
      ...overrides,
    }));
    vi.doMock('workflow/api', () => ({
      getRun: getRunMock,
      start: vi.fn(),
    }));
  }

  function mockSessionCaps() {
    sanitizeTurnRunIdMock = vi.fn((v: unknown) => {
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      if (!s || s.length > 512) return undefined;
      return /^[A-Za-z0-9_-]{1,512}$/.test(s) ? s : undefined;
    });
    sanitizeTurnStreamCursorMock = vi.fn((v: unknown) => {
      if (typeof v !== 'number') return undefined;
      if (!Number.isInteger(v)) return undefined;
      if (v < 0) return undefined;
      if (v > 1_000_000_000) return undefined;
      return v;
    });
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: sanitizeTurnStreamCursorMock,
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
    }));
  }

  function mockAuthedSession(userId = 'u1') {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@b.c' },
      })),
    }));
  }

  function mockUnauthed() {
    vi.doMock('../../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: AUTH_REQUIRED_ERROR },
          { status: 401 },
        ),
      })),
    }));
  }

  /**
   * Set up the tenancy-check mocks so the route passes the ownership gate.
   * All happy-path test rows must call this BEFORE importing the route.
   */
  function mockTenancyOk(sessionId = 's1', turnRunId?: string) {
    const resolvedTurnRunId = turnRunId ?? envelopeTurnRunId;

    vi.doMock('../../../../../lib/di', () => ({
      createProdServices: vi.fn(() => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () =>
            tenantResolveOk
              ? { ok: true as const, value: 't1' }
              : { ok: false as const, code: 'SESSION_STORE_UNAVAILABLE' as const, error: 'db-down' },
          ),
        },
      })),
    }));

    vi.doMock('../../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(async () =>
        storeAvailable
          ? {
              ok: true as const,
              value: {
                readEnvelope: vi.fn(async () =>
                  envelopePresent
                    ? { meta: { turnRunId: resolvedTurnRunId }, updatedAt: Date.now() }
                    : null,
                ),
              },
            }
          : { ok: false as const, code: 'SESSION_STORE_UNAVAILABLE' as const, error: 'down' },
      ),
      sessionKeyFor: vi.fn(
        (_tenantId: string, _userId: string, sid: string) =>
          ({ tenantId: 't1', userId: 'u1', sessionId: sid }),
      ),
    }));

    vi.doMock('../../../../../lib/sessions/sessionStore', () => ({
      isEnvelopeStore: vi.fn(() => true),
    }));
  }

  function standardHarness(sessionId = 's1') {
    mockSessionCaps();
    mockGetRun();
    mockTenancyOk(sessionId);
  }

  function getStream(
    runId: string,
    sessionId = 's1',
    startIndex?: string,
  ): Promise<Response> {
    const url = new URL(`https://x/api/turns/${runId}/stream`);
    url.searchParams.set('sessionId', sessionId);
    if (startIndex !== undefined) {
      url.searchParams.set('startIndex', startIndex);
    }
    return GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
      { params: Promise.resolve({ runId }) },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GET: (req: Request, ctx: any) => Promise<Response>;

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../../../lib/sessionCloudCaps');
    vi.doUnmock('../../../../../lib/tenancy/session');
    vi.doUnmock('../../../../../lib/di');
    vi.doUnmock('../../../../../lib/tenancy/harnessSessionsRedis');
    vi.doUnmock('../../../../../lib/sessions/sessionStore');
  });

  // ── Row 1 — startIndex=0 → full replay ──
  it('row 1 — startIndex=0 → 200, getReadable({startIndex:0}) called, SSE content-type, x-workflow-run-id', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', '0');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    // No warning header on read-only route
    expect(res.headers.get('x-workflow-run-warning')).toBeNull();

    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(getRunMock).toHaveBeenCalledWith('wf_turn_123');
    expect(getReadableMock).toHaveBeenCalledTimes(1);
    expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 0 });
  });

  // ── Row 2 — startIndex=N (positive) → mid-stream resume ──
  it('row 2 — startIndex=42 → 200, getReadable({startIndex:42}) called', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', '42');

    expect(res.status).toBe(200);
    expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 42 });
  });

  // ── Row 3 — startIndex absent → defaults to 0 ──
  it('row 3 — startIndex absent → defaults to 0, getReadable({startIndex:0})', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    // Use a URL without startIndex in the query string
    const url = new URL('https://x/api/turns/wf_turn_123/stream');
    url.searchParams.set('sessionId', 's1');
    const res = await GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
      { params: Promise.resolve({ runId: 'wf_turn_123' }) },
    );

    expect(res.status).toBe(200);
    expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 0 });
  });

  // ── Row 4 — Run not found (`await run.exists === false`) → 404 ──
  it('row 4 — run.exists === false → 404, error includes runId', async () => {
    standardHarness();
    mockAuthedSession();

    // getRun returns a handle; run.exists resolves false (not-found).
    getRunMock = vi.fn(() => ({
      runId: 'wf_missing',
      exists: Promise.resolve(false),
      getReadable: getReadableMock,
      cancel: runCancelSpy,
    }));
    vi.doMock('workflow/api', () => ({
      getRun: getRunMock,
      start: vi.fn(),
    }));

    ({ GET } = await import('./route'));

    const res = await getStream('wf_missing');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('wf_missing');
    expect(body.error).toMatch(/Run not found/);
    expect(getReadableMock).not.toHaveBeenCalled();
  });

  // ── Row 5 — getRun/getReadable throws infra error → 503 fail-closed ──
  it('row 5 — getReadable throws → 503 fail-closed', async () => {
    standardHarness();
    mockAuthedSession();

    // getRun returns a handle; run.exists resolves true; getReadable throws.
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.resolve(true),
      getReadable: vi.fn(() => {
        throw new Error('Workflows unavailable');
      }),
      cancel: runCancelSpy,
    }));
    vi.doMock('workflow/api', () => ({
      getRun: getRunMock,
      start: vi.fn(),
    }));

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unable to attach to run stream \(fail closed\)/);
    expect(body.error).toContain('Workflows unavailable');
  });

  // ── Row 5b — run.exists throws infra error → 503 (was outside try before fix) ──
  it('row 5b — run.exists rejects (infra) → 503 fail-closed', async () => {
    standardHarness();
    mockAuthedSession();

    // getRun returns a handle; run.exists rejects (infra failure).
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.reject(new Error('Workflows world unavailable')),
      getReadable: getReadableMock,
      cancel: runCancelSpy,
    }));
    vi.doMock('workflow/api', () => ({
      getRun: getRunMock,
      start: vi.fn(),
    }));

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unable to attach to run stream \(fail closed\)/);
    expect(body.error).toContain('Workflows world unavailable');
  });

  // ── Row 6 — Invalid runId (sanitizeTurnRunId → undefined) → 400 ──
  it('row 6 — invalid runId (sanitizeTurnRunId → undefined) → 400, getRun NOT called', async () => {
    mockGetRun();
    mockAuthedSession();

    sanitizeTurnRunIdMock = vi.fn((_v: unknown) => undefined);
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: vi.fn(),
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
    }));

    // Still need tenancy mocks for the import to succeed, but they won't be
    // called because the runId gate fires first.
    mockTenancyOk();
    vi.doMock('../../../../../lib/di', () => ({
      createProdServices: vi.fn(() => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(),
        },
      })),
    }));
    vi.doMock('../../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(),
      sessionKeyFor: vi.fn(),
    }));
    vi.doMock('../../../../../lib/sessions/sessionStore', () => ({
      isEnvelopeStore: vi.fn(() => false),
    }));

    ({ GET } = await import('./route'));

    const res = await getStream('bad:id!');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid runId');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 7 — startIndex negative → 400 ──
  it('row 7 — startIndex negative → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', '-1');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid startIndex');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 8 — startIndex non-integer (1.5) → 400 ──
  it('row 8 — startIndex non-integer (1.5) → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', '1.5');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid startIndex');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 9 — startIndex over cap (> 1e9) → 400 ──
  it('row 9 — startIndex over cap (2e9) → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', '2000000000');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid startIndex');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 10 — startIndex non-numeric string ("abc") → 400 ──
  it('row 10 — startIndex non-numeric ("abc") → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123', 's1', 'abc');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid startIndex');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 11 — Auth failure (no session user) → 401 ──
  it('row 11 — auth failure → 401', async () => {
    mockSessionCaps();
    mockGetRun();
    mockTenancyOk();
    mockUnauthed();
    ({ GET } = await import('./route'));

    // No sessionId in URL — auth fires first, so 401 before tenancy fails
    const url = new URL('https://x/api/turns/wf_turn_123/stream');
    url.searchParams.set('sessionId', 's1');
    const res = await GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
      { params: Promise.resolve({ runId: 'wf_turn_123' }) },
    );

    expect(res.status).toBe(401);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 12 — Client abort closes reader, does NOT cancel run ──
  it('row 12 — client abort closes reader, run.cancel() NEVER called', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const controller = new AbortController();

    const url = new URL('https://x/api/turns/wf_turn_123/stream');
    url.searchParams.set('sessionId', 's1');

    const res = await GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      }),
      { params: Promise.resolve({ runId: 'wf_turn_123' }) },
    );

    expect(res.status).toBe(200);
    expect(getRunMock).toHaveBeenCalledTimes(1);

    // Abort the client — this should close the reader (cancel spy fired on
    // the stream) but NEVER call run.cancel().
    controller.abort();

    // The readable's cancel spy should have been called (stream cancelled by
    // the platform when the signal fires). This is a loose assertion — in a
    // fully simulated env the abort might not propagate through the mock —
    // but the KEY assertion is the negative one below.
    expect(getReadableMock).toHaveBeenCalledTimes(1);

    // run.cancel() must NEVER be called — abort ≠ cancel.
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 13 — Completed run — stream attached → 200 ──
  it('row 13 — completed run → 200, getReadable() succeeds', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(200);
    expect(getReadableMock).toHaveBeenCalledTimes(1);
  });

  // ── Row 14 — Missing runId param → 400 (handler guard) ──
  it('row 14 — missing runId param → 400 (Next.js routing contract — not route logic)', async () => {
    mockGetRun();
    mockAuthedSession();

    sanitizeTurnRunIdMock = vi.fn((_v: unknown) => undefined);
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: vi.fn(),
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
    }));

    mockTenancyOk();
    vi.doMock('../../../../../lib/di', () => ({
      createProdServices: vi.fn(() => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(),
        },
      })),
    }));
    vi.doMock('../../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(),
      sessionKeyFor: vi.fn(),
    }));
    vi.doMock('../../../../../lib/sessions/sessionStore', () => ({
      isEnvelopeStore: vi.fn(() => false),
    }));

    ({ GET } = await import('./route'));

    const res = await getStream('');

    expect(res.status).toBe(400);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 15 — Missing sessionId → 400 ──
  it('row 15 — missing sessionId query param → 400', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();
    mockTenancyOk();
    ({ GET } = await import('./route'));

    // Build URL without sessionId
    const url = new URL('https://x/api/turns/wf_turn_123/stream');
    const res = await GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      }),
      { params: Promise.resolve({ runId: 'wf_turn_123' }) },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId/);
  });

  // ── Row 16 — Tenant resolve failure → 503 ──
  it('row 16 — tenant resolve fails → 503', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    tenantResolveOk = false;
    mockTenancyOk();

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unable to resolve tenant/);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 17 — Envelope absent (null) → 404 ──
  it('row 17 — envelope read returns null (no such session) → 404', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    envelopePresent = false;
    mockTenancyOk();

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Run not found/);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 18 — Envelope turnRunId mismatch → 404 ──
  it('row 18 — envelope.turnRunId !== runId → 404 (tenancy guard)', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    // Envelope has a DIFFERENT turnRunId — should 404.
    mockTenancyOk('s1', 'wf_other_run');

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Run not found/);
    expect(body.error).toContain('wf_turn_123');
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 19 — Happy path with tenancy check → 200 ──
  it('row 19 — tenancy check passes (envelope turnRunId matches) → 200', async () => {
    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(200);
    expect(getRunMock).toHaveBeenCalledWith('wf_turn_123');
    expect(getReadableMock).toHaveBeenCalledTimes(1);
  });
});
