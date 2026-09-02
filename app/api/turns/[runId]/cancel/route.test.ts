import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../../../lib/tenancy/errors';

/**
 * Route tests for backend-agents G22 (#816) — `POST /api/turns/:runId/cancel`
 * durable-turn server cancel seam.
 *
 * Mocks `getRun`, `sanitizeTurnRunId`, `isRedisSafeOpaqueId`,
 * `requireSessionUser`, `resolveSessionStore`, `sessionKeyFor`,
 * `isEnvelopeStore`, `overlayWorkerMeta`, and `createProdServices` so the
 * route never opens a real DB/Redis connection or reaches the Workflows API.
 *
 * Covers the locked test matrix (plan #816 Testing §Route unit):
 *   1. 401 unauth (requireSessionUser gate fires first)
 *   2. 400 invalid runId (sanitizeTurnRunId → undefined)
 *   3. 400 missing sessionId
 *   3b. 400 invalid (non-opaque) sessionId
 *   4. 404 ownership mismatch (envelope.turnRunId !== runId)
 *   4b. 404 absent run (run.exists === false)
 *   5. 409 terminal-with-status no-op (run.cancel NOT called, no overlay)
 *   6. live run → cancel() called exactly once + 'cancelling' overlay PATCH
 *      with strictly-newer updatedAt (LWW: Math.max(now, stored+1))
 *   7. cancel throw → 503 fail-closed and NO overlay write
 *   8. store unavailable → 503 (resolve not-ok / resolve throws / read throws)
 *   9. 429 min-interval soft guard: second accepted cancel inside the window
 *      → 429 + Retry-After; a terminal 409 / 404 / 503 never burns the window
 *  10. accepted cancel with overlay {ok:false} → still 200 + warning (PATCH
 *      failure is non-fatal — the run's own terminal persist owns the truth)
 *  11. tenant resolve failure → 503
 */

/** Distant-future stored updatedAt so the LWW clock assertion proves stored+1. */
const FUTURE_UPDATED_AT = 9_000_000_000_000;

describe('POST /api/turns/:runId/cancel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sanitizeTurnRunIdMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let isRedisSafeOpaqueIdMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let overlayWorkerMetaMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readEnvelopeMock: any;

  /** Spy on run.cancel — asserted exactly-once on accept, never on terminal. */
  let runCancelSpy: ReturnType<typeof vi.fn>;

  // Tenancy mock state
  let envelopeTurnRunId: string;
  let envelopePresent: boolean;
  let tenantResolveOk: boolean;
  let storeAvailable: boolean;
  let storeResolveThrows: boolean;
  let readEnvelopeThrows: boolean;
  let runStatus: string;
  let runExists: boolean;

  function resetState() {
    runCancelSpy = vi.fn(async () => {});
    overlayWorkerMetaMock = vi.fn(async () => ({ ok: true as const, meta: {} }));
    readEnvelopeMock = vi.fn(async () => {
      if (readEnvelopeThrows) throw new Error('read-envelope-crash');
      return envelopePresent
        ? { meta: { turnRunId: envelopeTurnRunId }, updatedAt: FUTURE_UPDATED_AT }
        : null;
    });

    envelopeTurnRunId = 'wf_turn_123';
    envelopePresent = true;
    tenantResolveOk = true;
    storeAvailable = true;
    storeResolveThrows = false;
    readEnvelopeThrows = false;
    runStatus = 'running';
    runExists = true;
  }

  function mockGetRun() {
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.resolve(runExists),
      status: Promise.resolve(runStatus),
      cancel: runCancelSpy,
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
    isRedisSafeOpaqueIdMock = vi.fn((s: unknown) => {
      if (typeof s !== 'string') return false;
      return /^[A-Za-z0-9_-]{1,512}$/.test(s);
    });
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      isRedisSafeOpaqueId: isRedisSafeOpaqueIdMock,
      TURN_CANCEL_MIN_INTERVAL_MS: 1000,
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

  function mockTenancyOk(sessionId = 's1', turnRunId?: string) {
    const resolvedTurnRunId = turnRunId ?? envelopeTurnRunId;
    envelopeTurnRunId = resolvedTurnRunId;

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
          value: { readEnvelope: readEnvelopeMock },
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

    vi.doMock('../../../../../lib/agent/workerMetaOverlay', () => ({
      overlayWorkerMeta: overlayWorkerMetaMock,
    }));
  }

  function standardHarness(sessionId = 's1') {
    mockSessionCaps();
    mockGetRun();
    mockTenancyOk(sessionId);
  }

  function postCancel(runId: string, sessionId?: string): Promise<Response> {
    const url = new URL(`https://x/api/turns/${runId}/cancel`);
    if (sessionId !== undefined) url.searchParams.set('sessionId', sessionId);
    return POST(
      new Request(url, { method: 'POST' }),
      { params: Promise.resolve({ runId }) },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (req: Request, ctx: any) => Promise<Response>;

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
    vi.doUnmock('../../../../../lib/agent/workerMetaOverlay');
  });

  // ── Row 1 — 401 unauth ──
  it('row 1 — auth failure → 401 before any gate', async () => {
    standardHarness();
    mockUnauthed();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: AUTH_REQUIRED_ERROR });
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  // ── Row 2 — 400 invalid runId ──
  it('row 2 — invalid runId (sanitizeTurnRunId → undefined) → 400, getRun NOT called', async () => {
    mockGetRun();
    mockAuthedSession();

    sanitizeTurnRunIdMock = vi.fn((_v: unknown) => undefined);
    vi.doMock('../../../../../lib/sessionCloudCaps', () => ({
      sanitizeTurnRunId: sanitizeTurnRunIdMock,
      isRedisSafeOpaqueId: vi.fn(() => true),
      TURN_CANCEL_MIN_INTERVAL_MS: 1000,
    }));

    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('bad:id!', 's1');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid runId');
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 3 — 400 missing sessionId ──
  it('row 3 — missing sessionId query param → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId/);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 3b — 400 invalid (non-opaque) sessionId ──
  it('row 3b — invalid (non-opaque) sessionId → 400', async () => {
    standardHarness();
    mockAuthedSession();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', '*');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid sessionId/);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 4 — 404 ownership mismatch ──
  it('row 4 — envelope.turnRunId !== runId → 404 (tenancy guard), getRun NOT called', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    mockTenancyOk('s1', 'wf_other_run');
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Run not found/);
    expect(body.error).toContain('wf_turn_123');
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  // ── Row 4b — 404 absent run ──
  it('row 4b — run.exists === false → 404, cancel NOT called', async () => {
    standardHarness();
    mockAuthedSession();
    runExists = false;
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Run not found/);
    expect(runCancelSpy).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  // ── Row 5 — 409 terminal no-op ──
  it('row 5 — terminal run (completed) → 409 with status in body, cancel NOT called, no overlay', async () => {
    standardHarness();
    mockAuthedSession();
    runStatus = 'completed';
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body.runId).toBe('wf_turn_123');
    expect(body.status).toBe('completed');
    expect(runCancelSpy).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  it('row 5b — terminal run (failed) → 409 no-op', async () => {
    standardHarness();
    mockAuthedSession();
    runStatus = 'failed';
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');
    expect(res.status).toBe(409);
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  it('row 5c — terminal run (cancelled) → 409 no-op', async () => {
    standardHarness();
    mockAuthedSession();
    runStatus = 'cancelled';
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');
    expect(res.status).toBe(409);
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 6 — live run → cancel + 'cancelling' overlay ──
  it('row 6 — live run → 200, cancel() called exactly once, cancelling overlay PATCH with strictly-newer updatedAt', async () => {
    standardHarness();
    mockAuthedSession();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; turnStatus: string; warning?: string };
    expect(body.runId).toBe('wf_turn_123');
    expect(body.turnStatus).toBe('cancelling');
    expect(body.warning).toBeUndefined();
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(res.headers.get('x-workflow-run-warning')).toBeNull();

    expect(runCancelSpy).toHaveBeenCalledTimes(1);

    // 'cancelling' overlay PATCH — worker-owned key, copy-forward, LWW clock.
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
    const patchCall = overlayWorkerMetaMock.mock.calls[0][0];
    expect(patchCall.patch).toEqual({ turnStatus: 'cancelling' });
    expect(patchCall.envelopeStore).toBeTruthy();
    // LWW: Math.max(Date.now(), stored+1). stored+1 (9e12+1) > Date.now()
    // (~1.76e12) → clock MUST pick stored+1. A bare Date.now() would fail.
    expect(typeof patchCall.updatedAt).toBe('number');
    expect(patchCall.updatedAt).toBeGreaterThanOrEqual(FUTURE_UPDATED_AT + 1);
    expect(patchCall.key).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1' });
  });

  it('row 6b — live run (pending) → cancel() called', async () => {
    standardHarness();
    mockAuthedSession();
    runStatus = 'pending';
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');
    expect(res.status).toBe(200);
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
  });

  // ── Row 7 — cancel throw → 503 fail-closed, NO overlay ──
  it('row 7 — run.cancel() throws → 503 fail-closed, NO overlay write', async () => {
    standardHarness();
    mockAuthedSession();
    runCancelSpy = vi.fn(async () => {
      throw new Error('lost race: run already terminal');
    });
    mockGetRun();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/fail closed/);
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
    // The 'cancelling' marker must NOT persist on a failed cancel — never a
    // partial cancel claim.
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  it('row 7b — getRun status rejects (infra) → 503 fail-closed, cancel NOT called', async () => {
    standardHarness();
    mockAuthedSession();
    getRunMock = vi.fn(() => ({
      runId: 'wf_turn_123',
      exists: Promise.resolve(true),
      status: Promise.reject(new Error('Workflows world unavailable')),
      cancel: runCancelSpy,
    }));
    vi.doMock('workflow/api', () => ({ getRun: getRunMock, start: vi.fn() }));
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/fail closed/);
    expect(runCancelSpy).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  // ── Row 8 — store unavailable → 503 ──
  it('row 8 — store resolve not-ok → 503 fail-closed, getRun NOT called', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    storeAvailable = false;
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  it('row 8b — store resolve throws → 503 fail-closed', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    storeResolveThrows = true;
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  it('row 8c — readEnvelope throws → 503 fail-closed', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    readEnvelopeThrows = true;
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/store unavailable/);
    expect(runCancelSpy).not.toHaveBeenCalled();
  });

  // ── Row 9 — 429 min-interval soft guard ──
  it('row 9 — second accepted cancel inside window → 429 + Retry-After; window advances only on accepted cancel', async () => {
    standardHarness();
    mockAuthedSession();
    ({ POST } = await import('./route'));

    // First cancel: accepted (live run), advances the window.
    const res1 = await postCancel('wf_turn_123', 's1');
    expect(res1.status).toBe(200);
    expect(runCancelSpy).toHaveBeenCalledTimes(1);

    // Second cancel immediately: 429 (window not elapsed).
    const res2 = await postCancel('wf_turn_123', 's1');
    expect(res2.status).toBe(429);
    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toMatch(/too many cancel requests/i);
    expect(res2.headers.get('Retry-After')).toBe('1');
    // Still only one cancel() — the 429 never reached the run.
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
  });

  it('row 9b — a terminal 409 does NOT burn the window (follow-up live cancel accepted)', async () => {
    standardHarness();
    mockAuthedSession();
    // First: terminal run → 409 (no cancel, no window advance).
    runStatus = 'completed';
    mockGetRun();
    ({ POST } = await import('./route'));

    const res1 = await postCancel('wf_turn_123', 's1');
    expect(res1.status).toBe(409);
    expect(runCancelSpy).not.toHaveBeenCalled();

    // Second: live run → 200 (the 409 never advanced the window).
    runStatus = 'running';
    mockGetRun();
    const res2 = await postCancel('wf_turn_123', 's1');
    expect(res2.status).toBe(200);
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
  });

  it('row 9c — a 404 (ownership) does NOT burn the window', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    mockTenancyOk('s1', 'wf_other_run');
    ({ POST } = await import('./route'));

    const res1 = await postCancel('wf_turn_123', 's1');
    expect(res1.status).toBe(404);

    // Fix ownership → live cancel accepted (the 404 never advanced the window).
    mockTenancyOk('s1', 'wf_turn_123');
    ({ POST } = await import('./route'));
    const res2 = await postCancel('wf_turn_123', 's1');
    expect(res2.status).toBe(200);
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
  });

  // ── Row 10 — accepted cancel with overlay {ok:false} → still 200 + warning ──
  it('row 10 — accepted cancel + overlay {ok:false} → 200 with warning (PATCH failure non-fatal)', async () => {
    standardHarness();
    mockAuthedSession();
    overlayWorkerMetaMock = vi.fn(async () => ({
      ok: false as const,
      code: 'lww_conflict',
      error: 'worker PATCH updatedAt <= stored envelope updatedAt.',
    }));
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    // Still 200 — the cancel WAS accepted; the marker PATCH is best-effort.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; turnStatus: string; warning?: string };
    expect(body.runId).toBe('wf_turn_123');
    expect(body.turnStatus).toBe('cancelling');
    expect(body.warning).toBe('Cancelling PATCH did not persist (lww_conflict)');
    expect(res.headers.get('x-workflow-run-warning')).toBe(
      'Cancelling PATCH did not persist (lww_conflict)',
    );
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
  });

  it('row 10b — accepted cancel + overlay throws → 200 with warning', async () => {
    standardHarness();
    mockAuthedSession();
    overlayWorkerMetaMock = vi.fn(async () => {
      throw new Error('Redis write timeout.');
    });
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toBe('Cancelling PATCH failed to persist');
    expect(res.headers.get('x-workflow-run-warning')).toBe(
      'Cancelling PATCH failed to persist',
    );
    expect(runCancelSpy).toHaveBeenCalledTimes(1);
  });

  // ── Row 11 — tenant resolve failure → 503 ──
  it('row 11 — tenant resolve fails → 503, getRun NOT called', async () => {
    mockSessionCaps();
    mockGetRun();
    mockAuthedSession();
    tenantResolveOk = false;
    mockTenancyOk();
    ({ POST } = await import('./route'));

    const res = await postCancel('wf_turn_123', 's1');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unable to resolve tenant/);
    expect(getRunMock).not.toHaveBeenCalled();
    expect(runCancelSpy).not.toHaveBeenCalled();
  });
});
