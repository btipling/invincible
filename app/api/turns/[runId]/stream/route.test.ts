import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Route tests for backend-agents C16 (#810) — `GET /api/turns/:runId/stream`
 * durable-turn stream attach/reconnect.
 *
 * Mocks `getRun`, `sanitizeTurnRunId`, `sanitizeTurnStreamCursor`,
 * `isRedisSafeOpaqueId`, `requireSessionUser`, `resolveSessionStore`,
 * `sessionKeyFor`, `isEnvelopeStore`, and `createProdServices` so the route
 * never opens a real DB/Redis connection or reaches the Workflows API.
 *
 * Covers the test matrix:
 *   1. startIndex=0 → full replay
 *   2. startIndex=N → mid-stream resume
 *   3. startIndex absent → defaults to 0
 *   4. Run not found → 404
 *   5. getReadable throws → 503 fail-closed
 *   5b. run.exists rejects → 503 fail-closed
 *   6. Invalid runId → 400
 *   7. startIndex negative → 400
 *   8. startIndex non-integer → 400
 *   9. startIndex over cap → 400
 *  10. startIndex non-numeric → 400
 *  11. Auth failure → 401
 *  12. Client abort during stream — run.cancel() NEVER called (abort ≠ cancel)
 *  13. Completed run → 200
 *  14. Missing runId param → 400 (handler guard)
 *
 *  15. Missing sessionId → 400
 *  15b. Invalid (non-opaque) sessionId → 400
 *  16. Tenant resolve failure → 503
 *  17. Envelope absent (miss) → 404
 *  18. Envelope turnRunId mismatch → 404
 *  19. Happy path with tenancy check → 200
 *  20. Store resolve not-ok (store unavailable) → 503 fail-closed
 *  20b. Store resolve throws → 503 fail-closed
 *  21. readEnvelope throws → 503 fail-closed
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let isRedisSafeOpaqueIdMock: any;

  /** Spy on the returned readable stream's cancel method (Row 12). */
  let readableCancelSpy: ReturnType<typeof vi.fn>;

  /** Spy on run.cancel — must NEVER be called (abort ≠ cancel). */
  let runCancelSpy: ReturnType<typeof vi.fn>;

  // Tenancy mock state
  let envelopeTurnRunId: string;
  let envelopePresent: boolean;
  let tenantResolveOk: boolean;
  let storeAvailable: boolean;
  let storeResolveThrows: boolean;
  let readEnvelopeThrows: boolean;

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
    storeResolveThrows = false;
    readEnvelopeThrows = false;
  }

  function mockGetRun(overrides: Record<string, unknown> = {}) {
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.resolve(true),
      getReadable: getReadableMock,
      cancel: runCancelSpy,
      status: Promise.resolve('running'),
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
    isRedisSafeOpaqueIdMock = vi.fn((s: unknown) => {
      if (typeof s !== 'string') return false;
      return /^[A-Za-z0-9_-]{1,512}$/.test(s);
    });
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: sanitizeTurnStreamCursorMock,
      isRedisSafeOpaqueId: isRedisSafeOpaqueIdMock,
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
      TURN_STREAM_STATUS_POLL_MS: 1000,
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
   *
   * Controls via module-scoped state flags:
   *  - `storeAvailable`: false → resolveSessionStore returns {ok:false}
   *  - `storeResolveThrows`: true → resolveSessionStore throws
   *  - `readEnvelopeThrows`: true → readEnvelope throws
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
      resolveSessionStore: vi.fn(async () => {
        if (storeResolveThrows) throw new Error('store-resolve-crash');
        if (!storeAvailable)
          return { ok: false as const, code: 'SESSION_STORE_UNAVAILABLE' as const, error: 'down' };
        return {
          ok: true as const,
          value: {
            readEnvelope: vi.fn(async () => {
              if (readEnvelopeThrows) throw new Error('read-envelope-crash');
              return envelopePresent
                ? { meta: { turnRunId: resolvedTurnRunId }, updatedAt: Date.now() }
                : null;
            }),
          },
        };
      }),
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
      isRedisSafeOpaqueId: vi.fn(() => true),
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
      TURN_STREAM_STATUS_POLL_MS: 1000,
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

  // ── Row 12 — Client abort during stream, run.cancel() NEVER called ──
  // Uses a never-closing stream so the abort fires while the stream is still
  // active (not after handler return). Key assertion: run.cancel() is NEVER
  // called — abort ≠ cancel per C16 parent lock.
  it('row 12 — client abort during stream, run.cancel() NEVER called', async () => {
    // Create a lingering stream that never closes, so the GET response body
    // stays open while we abort mid-stream.
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const lingeringStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"a"}\n\n'));
        // NOTE: never calls controller.close() — stream stays open
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (lingeringStream as any).cancel = readableCancelSpy;
    getReadableMock = vi.fn(() => lingeringStream);

    standardHarness();
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const controller = new AbortController();

    const url = new URL('https://x/api/turns/wf_turn_123/stream');
    url.searchParams.set('sessionId', 's1');

    // Start the GET — don't await. The response headers are sent immediately
    // but the body streams from the never-closing ReadableStream.
    const resPromise = GET(
      new Request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      }),
      { params: Promise.resolve({ runId: 'wf_turn_123' }) },
    );

    // Abort during active streaming (before the stream closes).
    controller.abort();

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(getRunMock).toHaveBeenCalledTimes(1);

    // run.cancel() must NEVER be called — abort ≠ cancel (C16 parent lock).
    expect(runCancelSpy).not.toHaveBeenCalled();

    // Cleanup the lingering stream controller.
    streamController!.close();
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

  it('row 13b — cancelled hanging getReadable → 200 SSE terminates with Request cancelled.', async () => {
    const hangingStream = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue / close — platform cancel hang */
      },
    });
    getReadableMock = vi.fn(() => hangingStream);
    standardHarness();
    mockGetRun({ status: Promise.resolve('cancelled') });
    mockAuthedSession();
    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(
      true,
    );
    const text = await res.text();
    expect(text).toContain('Request cancelled.');
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 14 — Missing runId param → 400 (handler guard) ──
  it('row 14 — missing runId param → 400 (Next.js routing contract — not route logic)', async () => {
    mockGetRun();
    mockAuthedSession();

    sanitizeTurnRunIdMock = vi.fn((_v: unknown) => undefined);
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: vi.fn(),
      isRedisSafeOpaqueId: vi.fn(() => true),
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
      TURN_STREAM_STATUS_POLL_MS: 1000,
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

  // ── Row 15b — Invalid (non-opaque) sessionId → 400 ──
  it('row 15b — invalid (non-opaque) sessionId → 400', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();
    mockTenancyOk();
    ({ GET } = await import('./route'));

    // sessionId "*" is NOT Redis-safe-opaque — isRedisSafeOpaqueId returns false.
    const res = await getStream('wf_turn_123', '*');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid sessionId/);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 15c — sessionId injectable (isRedisSafeOpaqueId overridden false) → 400 ──
  it('row 15c — isRedisSafeOpaqueId returns false even for plausible string → 400', async () => {
    mockAuthedSession();
    mockGetRun();

    // Mock isRedisSafeOpaqueId to reject even "s1" — proves the gate is
    // `isRedisSafeOpaqueId`, not a simple truthiness check.
    isRedisSafeOpaqueIdMock = vi.fn((_s: unknown) => false);
    sanitizeTurnRunIdMock = vi.fn((v: unknown) => {
      if (typeof v !== 'string') return undefined;
      return /^[A-Za-z0-9_-]{1,512}$/.test(v) ? v : undefined;
    });
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      sanitizeTurnStreamCursor: vi.fn(),
      isRedisSafeOpaqueId: isRedisSafeOpaqueIdMock,
      TURN_STREAM_CURSOR_MAX: 1_000_000_000,
      TURN_STREAM_STATUS_POLL_MS: 1000,
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

    const res = await getStream('wf_turn_123', 's1');

    expect(res.status).toBe(400);
    expect(getRunMock).not.toHaveBeenCalled();
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

  // ── Row 20 — Store resolve not-ok (store unavailable) → 503 fail-closed ──
  it('row 20 — store resolve not-ok (store unavailable) → 503 fail-closed', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    storeAvailable = false;
    mockTenancyOk();

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 20b — Store resolve throws → 503 fail-closed ──
  it('row 20b — store resolve throws → 503 fail-closed', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    storeResolveThrows = true;
    mockTenancyOk();

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  // ── Row 21 — readEnvelope throws → 503 fail-closed ──
  it('row 21 — readEnvelope throws → 503 fail-closed', async () => {
    mockSessionCaps();
    mockAuthedSession();
    mockGetRun();

    readEnvelopeThrows = true;
    mockTenancyOk();

    ({ GET } = await import('./route'));

    const res = await getStream('wf_turn_123');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(getRunMock).not.toHaveBeenCalled();
  });
});
