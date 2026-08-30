import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';

/**
 * Distant-future `updatedAt` planted in the mock envelope for row 1, so the
 * LWW clock assertion can prove `Math.max(Date.now(), stored+1)` is strictly
 * newer. If the clock regresses to bare `Date.now()`, patch.updatedAt would be
 * ~1.76e12 which is < FUTURE_UPDATED_AT + 1 → test fails.
 */
const FUTURE_UPDATED_AT = 9_000_000_000_000;

/**
 * Route tests for backend-agents C14b (#835) + C14d (#833) + C15 (#809) —
 * `POST /api/turns` durable-turn start surface, durable running PATCH, and
 * abuse guards (429 per-process min-interval + 409 live-only duplicate).
 * Mocks the SDK `start`, the DI root, the workflow entry, and
 * `overlayWorkerMeta` so the route never enqueues a real Workflow run, opens a
 * DB/Redis connection, or constructs a real persist seam. Covers the matrix
 * rows 1–7 (C14b/C14d) + rows 8–15 (C15 abuse guards).
 *
 * The route passes ONLY serializable values to `start()` — `scope`, `modelId`,
 * `userMessage`, and optional `persistRunBind`. NO `tools` dict — tool schemas
 * are assembled in-step via the shared `assembleDurableToolWorld` helper.
 * The route MUST NOT call `setPersistSeamResolver` / `setToolWorldResolver`
 * (those are test overrides). No real `createDbConnection` / PGlite —
 * everything is injected through the mocked composition root (DI/cost gate).
 */
describe('POST /api/turns', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let startMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getRunMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let turnWorkflowMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parseAgentBodyMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveSessionStoreMock: any;
  /** Spy on the sandbox probe client close call — asserts handle is dropped. */
  let sandboxCloseSpy: ReturnType<typeof vi.fn>;

  /** Spy on overlayWorkerMeta — defaults to success; override for row 4. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let overlayWorkerMetaMock: any;

  /** Mock for the envelope `readEnvelope` — plant turnStatus for 409 rows. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readEnvelopeMock: any;

  function resetServiceState() {
    delete servicesState.harnessSessionsRedis;
    delete servicesState.resolveInferenceForRequest;
    delete servicesState.resolveSandbox;
    sandboxCloseSpy = vi.fn(async () => {});
    overlayWorkerMetaMock = vi.fn(async () => ({ ok: true as const, meta: {} }));
    readEnvelopeMock = vi.fn(async () => ({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
      },
    }));
  }

  function mockDi() {
    resetServiceState();
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 't1' })),
    };
    servicesState.resolveInferenceForRequest = {
      resolveByokForRequest: vi.fn(async () => ({
        ok: true as const,
        modelId: 'anthropic/claude-a',
        provider: 'anthropic',
        credentials: { apiKey: 'sk-test' },
        only: ['anthropic'] as [string],
        byok: { anthropic: [{ apiKey: 'sk-test' }] },
        secretId: 'sec-1',
        secretsToRedact: ['sk-test'],
      })),
    };
    // resolveSandbox: mocked for pre-start hard-deny gate (default: ok).
    // sandboxCloseSpy tracks the probe client's close call.
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: { close: sandboxCloseSpy },
          secrets: [],
          permissions: { canRead: true, canWrite: true },
          workspaceRoot: '/workspace',
          backend: 'byo' as const,
          sandboxId: 'sb_ok',
          name: 'Sandbox',
          slug: 'sandbox',
          status: 'active',
          resolvedImage: null,
        },
      })),
    };
    // userGithubToken: default decrypt succeeds.
    servicesState.userGithubToken = {
      decryptUserGithubTokenForServer: vi.fn(async () => ({ ok: true as const, value: 'gh_pat' })),
    };
    // userSandboxInstance: default loadInstance returns no HTTP instance.
    servicesState.userSandboxInstance = {
      loadInstance: vi.fn(async () => ({ ok: true as const, value: null })),
    };
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  function mockWorkflowEntry() {
    turnWorkflowMock = vi.fn(async () => ({ status: 'completed' }));
    vi.doMock('../../../lib/workflows/turnWorkflow', () => ({
      turnWorkflow: turnWorkflowMock,
    }));
  }

  function mockMisc() {
    parseAgentBodyMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (body: any) => {
        const prompt = typeof body?.prompt === 'string' ? body.prompt : 'hi';
        return {
          ok: true as const,
          prompt,
          ...(typeof body?.modelId === 'string' ? { modelId: body.modelId } : {}),
          cwd: '.',
          ...(typeof body?.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body?.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
        };
      },
    );
    vi.doMock('../../../lib/agent/agentBody', () => ({
      parseAgentBody: parseAgentBodyMock,
    }));
    vi.doMock('../../../lib/chatServer', () => ({
      mapByokResolveFailure: (reason: string) => ({
        status: reason === 'forbidden' ? 403 : 503,
        error: 'Inference access denied.',
      }),
    }));
    // Mock resolveSessionStore to return a usable envelope store (for persistRunBind read).
    resolveSessionStoreMock = vi.fn(async () => ({
      ok: true as const,
      value: {
        readEnvelope: readEnvelopeMock,
      },
    }));
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: resolveSessionStoreMock,
      sessionKeyFor: (t: string, u: string, s: string) => ({ tenantId: t, userId: u, sessionId: s }),
    }));
    vi.doMock('../../../lib/sessions/sessionStore', () => ({
      isEnvelopeStore: () => true,
    }));
    // Mock overlayWorkerMeta — defaults to success via resetServiceState.
    vi.doMock('../../../lib/agent/workerMetaOverlay', () => ({
      overlayWorkerMeta: overlayWorkerMetaMock,
    }));
    vi.doMock('../../../lib/gateway/modelCatalog', () => ({
      effortValuesForModel: vi.fn(async () => []),
    }));
  }

  function mockStart(overrides: Record<string, unknown> = {}) {
    const getReadable = vi.fn(() => new ReadableStream());
    startMock = vi.fn(async () => ({
      runId: 'wf_turn_123',
      getReadable,
      exists: Promise.resolve(true),
      status: Promise.resolve('completed'),
      ...overrides,
    }));
    getRunMock = vi.fn(() => ({
      exists: Promise.resolve(true),
      status: Promise.resolve('running'),
    }));
    vi.doMock('workflow/api', () => ({ start: startMock, getRun: getRunMock }));
    return { getReadable };
  }

  function mockAuthedSession(userId = 'u1') {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@b.c' },
      })),
    }));
  }

  function mockUnauthed() {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      })),
    }));
  }

  function standardHarness() {
    mockDi();
    mockWorkflowEntry();
    mockMisc();
  }

  function postJson(body: unknown, accept?: string): Promise<Response> {
    return POST(
      new Request('https://x/api/turns', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accept ? { accept } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let POST: (req: Request) => Promise<Response>;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/agent/agentBody');
    vi.doUnmock('../../../lib/agent/workerMetaOverlay');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/workflows/turnWorkflow');
    vi.doUnmock('../../../lib/chatServer');
    vi.doUnmock('../../../lib/tenancy/harnessSessionsRedis');
    vi.doUnmock('../../../lib/sessions/sessionStore');
    vi.doUnmock('workflow/api');
    vi.doUnmock('../../../lib/gateway/modelCatalog');
    resetServiceState();
  });

  it('row 1 — authed valid sessionId+prompt → start called + running PATCH succeeds; returns {runId} + x-workflow-run-id, NO warning', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(res.headers.get('x-workflow-run-warning')).toBeNull();
    const json = await res.json();
    expect(json.runId).toBe('wf_turn_123');
    expect(json.warning).toBeUndefined();

    expect(startMock).toHaveBeenCalledTimes(1);
    const [wf, argsArr] = startMock.mock.calls[0];
    expect(wf).toBe(turnWorkflowMock);

    // start() args = exactly ONE TurnWorkflowArgs object
    const startArgs = argsArr[0];
    expect(startArgs.userMessage).toBe('hi');
    expect(startArgs.modelId).toBe('anthropic/claude-a');
    expect(startArgs.scope).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1' });
    expect(startArgs.tools).toBeUndefined();
    expect(startArgs.persistRunBind).toEqual({ cwd: 'app', activeSandboxId: 'sb_bind' });
    expect(startArgs.reasoning).toBeUndefined();

    // Probe client was closed after start() succeeded.
    expect(sandboxCloseSpy).toHaveBeenCalledTimes(1);

    // C14d: overlayWorkerMeta called with running PATCH.
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
    const patchCall = overlayWorkerMetaMock.mock.calls[0][0];
    expect(patchCall.patch).toEqual({ turnRunId: 'wf_turn_123', turnStatus: 'running' });
    expect(patchCall.envelopeStore).toBeTruthy();
    // LWW inputs: strictly-newer clock + correct scope key.
    // The mock envelope was planted with a distant-future updatedAt; the route
    // computes Math.max(Date.now(), stored+1). Since stored+1 (9e12+1) >
    // Date.now() (~1.76e12), the clock MUST pick stored+1 — never Date.now().
    // A bare Date.now() would be ~1.76e12 < 9e12+1 → this assertion fails.
    expect(typeof patchCall.updatedAt).toBe('number');
    expect(Number.isFinite(patchCall.updatedAt)).toBe(true);
    expect(patchCall.updatedAt).toBeGreaterThanOrEqual(FUTURE_UPDATED_AT + 1);
    expect(patchCall.key).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1' });
  });

  it('body reasoning is passed to start() (plan #897)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1', reasoning: 'low' });
    expect(res.status).toBe(200);
    const startArgs = startMock.mock.calls[0][1][0];
    expect(startArgs.reasoning).toBe('low');
    expect(startArgs.tools).toBeUndefined();
  });

  it('omitted body on glm-5.3-flash passes reasoning low to start() (plan #897 DoD)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      standardHarness();
      mockAuthedSession();
      mockStart();
      servicesState.resolveInferenceForRequest = {
        resolveByokForRequest: vi.fn(async () => ({
          ok: true as const,
          modelId: 'zai/glm-5.3-flash',
          provider: 'zai',
          credentials: { apiKey: 'sk-test' },
          only: ['zai'] as [string],
          byok: { zai: [{ apiKey: 'sk-test' }] },
          secretId: 'sec-1',
          secretsToRedact: ['sk-test'],
        })),
      };
      ({ POST } = await import('./route'));

      const res = await postJson({ prompt: 'hi', sessionId: 's1' });
      expect(res.status).toBe(200);
      const startArgs = startMock.mock.calls[0][1][0];
      expect(startArgs.modelId).toBe('zai/glm-5.3-flash');
      expect(startArgs.reasoning).toBe('low');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('non-empty Gateway list [high,xhigh] passes reasoning high to start() (adversarial-review #899)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      standardHarness();
      mockAuthedSession();
      mockStart();
      servicesState.resolveInferenceForRequest = {
        resolveByokForRequest: vi.fn(async () => ({
          ok: true as const,
          modelId: 'zai/glm-5.2',
          provider: 'zai',
          credentials: { apiKey: 'sk-test' },
          only: ['zai'] as [string],
          byok: { zai: [{ apiKey: 'sk-test' }] },
          secretId: 'sec-1',
          secretsToRedact: ['sk-test'],
        })),
      };
      vi.doMock('../../../lib/gateway/modelCatalog', () => ({
        effortValuesForModel: vi.fn(async () => ['high', 'xhigh']),
      }));
      ({ POST } = await import('./route'));

      const res = await postJson({ prompt: 'hi', sessionId: 's1' });
      expect(res.status).toBe(200);
      const startArgs = startMock.mock.calls[0][1][0];
      expect(startArgs.modelId).toBe('zai/glm-5.2');
      expect(startArgs.reasoning).toBe('high');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('row 2 — missing sessionId → 400 (parseAgentBody would pass; route guard rejects), no start, no running PATCH', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId is required/i);
    expect(startMock).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  it('row 3 — start throws → 503 fail-closed; in-flight flag cleared so a retry succeeds (not 409)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // First call: throw. Second call: succeed (proves in-flight was cleared).
    startMock
      .mockRejectedValueOnce(new Error('Workflow feature is not enabled for this project.'))
      .mockResolvedValueOnce({
        runId: 'wf_turn_456',
        getReadable: () => new ReadableStream(),
      });
    ({ POST } = await import('./route'));

    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res1.status).toBe(503);
    const body = (await res1.json()) as { error: string };
    expect(body.error).toMatch(/fail closed/i);
    expect(body.error).not.toMatch(/wf_turn_123/);
    expect(sandboxCloseSpy).toHaveBeenCalledTimes(1);
    // start threw before the running PATCH — overlayWorkerMeta never called.
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();

    // Follow-up: in-flight flag was cleared in the catch block → this request
    // succeeds (not a stale 409 from a leaked inFlight entry).
    const res2 = await postJson({ prompt: 'retry', sessionId: 's1' });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-workflow-run-id')).toBe('wf_turn_456');
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it('row 4a — running PATCH fails (overlayWorkerMeta returns {ok:false}) after start → non-500, still {runId} + warning header and body', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    overlayWorkerMetaMock.mockResolvedValue({
      ok: false,
      code: 'lww_conflict',
      error: 'worker PATCH updatedAt <= stored envelope updatedAt.',
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    // Non-500 — the run IS started.
    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    // Warning header is present — pinned to the exact stable string.
    expect(res.headers.get('x-workflow-run-warning')).toBe('Running PATCH did not persist (lww_conflict)');
    // JSON body still has runId + warning.
    const json = await res.json();
    expect(json.runId).toBe('wf_turn_123');
    expect(json.warning).toBe('Running PATCH did not persist (lww_conflict)');
    // start WAS called — the run was enqueued.
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 4b — running PATCH throws after start → non-500, still {runId} + warning', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    overlayWorkerMetaMock.mockRejectedValue(new Error('Redis write timeout.'));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(res.headers.get('x-workflow-run-warning')).toMatch(/Running PATCH failed to persist/);
    const json = await res.json();
    expect(json.runId).toBe('wf_turn_123');
    expect(json.warning).toMatch(/Running PATCH failed to persist/);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 4c — running PATCH fails on SSE path → non-500, SSE body + warning header, NO warning in body (SSE has no JSON body)', async () => {
    standardHarness();
    mockAuthedSession();
    const { getReadable } = mockStart();
    const fakeStream = new ReadableStream();
    getReadable.mockReturnValue(fakeStream);
    overlayWorkerMetaMock.mockResolvedValue({
      ok: false,
      code: 'read_failed',
      error: 'failed to read the envelope.',
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' }, 'text/event-stream');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    // Warning header on SSE response too.
    expect(res.headers.get('x-workflow-run-warning')).toMatch(/Running PATCH did not persist/);
    expect(res.body).toBe(fakeStream);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 4d — envelopeStore unavailable (resolveSessionStore fails) → 200, no warning (best-effort skip)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // resolveSessionStore returns a non-envelope store.
    resolveSessionStoreMock.mockResolvedValue({
      ok: false,
      error: 'session store unavailable.',
    });
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: resolveSessionStoreMock,
      sessionKeyFor: (t: string, u: string, s: string) => ({ tenantId: t, userId: u, sessionId: s }),
    }));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    // No warning — envelopeStore was null, running PATCH skipped silently.
    expect(res.headers.get('x-workflow-run-warning')).toBeNull();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 5 — Accept: text/event-stream → content-type AGENT_STREAM_CONTENT_TYPE + x-workflow-run-id; body is run.getReadable()', async () => {
    standardHarness();
    mockAuthedSession();
    const { getReadable } = mockStart();
    const fakeStream = new ReadableStream();
    getReadable.mockReturnValue(fakeStream);
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' }, 'text/event-stream');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.startsWith('text/event-stream')).toBe(true);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(getReadable).toHaveBeenCalledTimes(1);
    expect(res.body).toBe(fakeStream);
    expect(startMock).toHaveBeenCalledTimes(1);
    // Running PATCH was attempted (succeeds by default).
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
  });

  it('row 6 — Accept: application/json → JSON {runId}, not SSE content-type', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' }, 'application/json');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).not.toMatch(/text\/event-stream/i);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(await res.json()).toEqual({ runId: 'wf_turn_123' });
  });

  it('row 7 — unauthorized session → 401 auth gate before any persist wire / start', async () => {
    standardHarness();
    mockUnauthed();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: AUTH_REQUIRED_ERROR });
    expect(startMock).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  // --- C15 abuse-guard rows (plan #809) ---

  it('row 8 — 429 within interval: second request inside window → 429, Retry-After header present, start not called, overlayWorkerMeta not called', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    // First request: succeeds, advances lastStartAtMs for session s1.
    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res1.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    // Second request: hits the 429 min-interval guard (Date.now() is
    // milliseconds away from lastStartAtMs).
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    expect(res2.status).toBe(429);
    const body2 = await res2.json();
    expect(body2.error).toMatch(/too many turn start requests/i);
    // Retry-After header: computed from TURN_START_MIN_INTERVAL_MS (1000 ms → 1 s).
    expect(res2.headers.get('Retry-After')).toBe('1');

    // start() still called only once — the 429 never enqueued a run.
    expect(startMock).toHaveBeenCalledTimes(1);
    // overlayWorkerMeta was called for the FIRST request only (running PATCH).
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
  });

  it('row 8b — in-flight 409: concurrent same-session POSTs — second hits in-flight guard (flag set BEFORE BYOK await), first succeeds after gate resolves', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();

    // Hang BYOK resolve (the first gate that awaits AFTER inFlight is set)
    // so POST1 has the in-flight flag set but is stuck at the BYOK await.
    // A concurrent POST2 checks inFlight.has('s1') → true → 409 BEFORE any
    // I/O work. No artificial sleep — the in-flight flag is set synchronously
    // before the first `await`, so POST2 always sees it.
    let resolveByok: (v: unknown) => void;
    const byokPromise = new Promise((r) => { resolveByok = r; });
    servicesState.resolveInferenceForRequest.resolveByokForRequest =
      vi.fn(() => byokPromise);

    ({ POST } = await import('./route'));

    // Fire POST1 without awaiting — it sets inFlight synchronously,
    // then hangs at `await resolveByokForRequest(...)`.
    const res1Promise = postJson({ prompt: 'hi', sessionId: 's1' });

    // Second POST for the SAME session: inFlight.has('s1') → 409.
    // No sleep needed — POST1's inFlight flag was set synchronously before
    // the first `await`, and POST2's auth `await` yields to the microtask
    // queue; POST1's BYOK `await` is also pending → POST2 runs and sees
    // the flag.
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toBe('A turn is already being started for this session.');
    // start() never called for the second request.
    expect(startMock).not.toHaveBeenCalled();

    // Resolve BYOK → POST1 proceeds through remaining gates + start().
    resolveByok!({
      ok: true,
      modelId: 'anthropic/claude-a',
      provider: 'anthropic',
      credentials: { apiKey: 'sk-test' },
      only: ['anthropic'] as [string],
      byok: { anthropic: [{ apiKey: 'sk-test' }] },
      secretId: 'sec-1',
      secretsToRedact: ['sk-test'],
    });
    const res1 = await res1Promise;
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 8c — per-session isolation: user A turn does NOT 429 user B on the same isolate', async () => {
    standardHarness();
    mockAuthedSession('u1');
    mockStart();
    ({ POST } = await import('./route'));

    // User A (session s1) starts a turn → 200.
    const resA = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(resA.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    // User B (session s2) starts immediately — must NOT be 429'd.
    // The old process-global scalar would have 429'd every session for 1 s.
    const resB = await postJson({ prompt: 'hi', sessionId: 's2' });
    expect(resB.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(2);
  });

  it('row 9 — 200 after interval passes: second request outside window succeeds, lastStartAtMs advanced', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    // First request: succeeds, advances lastStartAtMs to wall-clock time.
    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res1.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    // Advance the clock past the 1 s interval via a Date.now() spy.
    const nowSpy = vi.spyOn(Date, 'now');
    // Plant a time far enough past the prior lastStartAtMs that the guard
    // passes.  The route reads Date.now() twice per request (429 check +
    // lastStartAtMs advancement), and once in the running PATCH clock.
    // We return a single large value each time — the 429 check is:
    //   now - lastStartAtMs >= 1000 → pass.
    // The running PATCH `Math.max(Date.now(), storedUpdatedAt + 1)` picks
    // stored+1 (FUTURE_UPDATED_AT is larger) regardless.
    nowSpy.mockReturnValue(9_000_000_000_000);
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    expect(res2.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('row 10 — 409 when turnStatus=running: start not called; follow-up 200 proves lastStartAtMs NOT advanced (409 never burns the window)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // Plant turnStatus='running' in the envelope — simulates a live turn.
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'running',
      },
    });
    ({ POST } = await import('./route'));

    // Pin the clock to a known value so we can prove the 409 did NOT advance
    // lastStartAtMs. If the 409 had called boundedSet(lastStartAtMs, 's1', CLOCK),
    // the follow-up POST (same clock) would hit the 429 guard:
    //   CLOCK - CLOCK = 0 < 1000 → 429.
    const CLOCK = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK);

    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res1.status).toBe(409);
    const body1 = await res1.json();
    expect(body1.error).toBe('A turn is already in progress for this session.');
    expect(startMock).not.toHaveBeenCalled();
    expect(getRunMock).not.toHaveBeenCalled();
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();

    // Now change the envelope to completed and send a follow-up at the SAME
    // clock value. Must be 200 — the 409 did NOT advance lastStartAtMs.
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'completed',
      },
    });
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    expect(res2.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('row 11 — 409 when turnStatus=cancelling: start not called; follow-up 200 proves lastStartAtMs NOT advanced', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'cancelling',
      },
    });
    ({ POST } = await import('./route'));

    const CLOCK = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK);

    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res1.status).toBe(409);
    expect(startMock).not.toHaveBeenCalled();

    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'completed',
      },
    });
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    expect(res2.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('row 10b — running + turnRunId + exists:false → not 409 (outage envelope); start called', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    getRunMock.mockImplementation(() => ({
      exists: Promise.resolve(false),
      status: Promise.resolve('failed'),
    }));
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'running',
        turnRunId: 'wf_dead_1',
      },
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res.status).toBe(200);
    expect(getRunMock).toHaveBeenCalledWith('wf_dead_1');
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 10c — running + exists + terminal failed status → not 409; start called', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    getRunMock.mockImplementation(() => ({
      exists: Promise.resolve(true),
      status: Promise.resolve('failed'),
    }));
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        turnStatus: 'running',
        turnRunId: 'wf_failed_1',
      },
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('row 10d — running + exists + non-terminal status → 409; start not called', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    getRunMock.mockImplementation(() => ({
      exists: Promise.resolve(true),
      status: Promise.resolve('running'),
    }));
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        turnStatus: 'running',
        turnRunId: 'wf_live_1',
      },
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res.status).toBe(409);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('row 10e — running + turnRunId + getRun/exists throw → 503; start not called', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    getRunMock.mockImplementation(() => {
      throw new Error('workflows down');
    });
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        turnStatus: 'running',
        turnRunId: 'wf_boom',
      },
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/fail closed/);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('row 12 — 200 when turnStatus=completed in envelope: start called (completed is non-live)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'completed',
      },
    });
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    // completed is a non-live terminal status → allowed.
    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
  });

  it('row 13 — 200 when turnStatus absent / no envelope: start called (absent is non-live)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // Default readEnvelopeMock returns NO turnStatus — should pass.
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(overlayWorkerMetaMock).toHaveBeenCalledTimes(1);
  });

  it('row 14 — 409 soft-path allow: envelope store unavailable → 200, start called (fail-open)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // resolveSessionStore fails → envelope store unavailable.
    resolveSessionStoreMock.mockResolvedValue({
      ok: false,
      error: 'session store unavailable.',
    });
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: resolveSessionStoreMock,
      sessionKeyFor: (t: string, u: string, s: string) => ({ tenantId: t, userId: u, sessionId: s }),
    }));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    // Fail-open: same as existing persistRunBind pattern — the turn starts.
    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);
    // Envelope store was null → no running PATCH (existing row 4d behavior).
    expect(overlayWorkerMetaMock).not.toHaveBeenCalled();
  });

  it('row 15 — 429 + 409 interaction: 429 fires first, 409 never checked (short-circuited)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    // First request: clean envelope (no turnStatus) → 200.
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: { logicalCwd: 'app', activeSandboxId: 'sb_bind' },
    });
    const res1 = await postJson({ prompt: 'hi', sessionId: 's1' });
    expect(res1.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);

    // Plant turnStatus='running' for second request — the 409 WOULD fire,
    // but the 429 guard runs first (gate ordering: 429 before envelope read)
    // and short-circuits without ever reaching the 409 check.
    readEnvelopeMock.mockResolvedValue({
      updatedAt: FUTURE_UPDATED_AT,
      meta: {
        logicalCwd: 'app',
        activeSandboxId: 'sb_bind',
        turnStatus: 'running',
      },
    });
    const res2 = await postJson({ prompt: 'hi again', sessionId: 's1' });
    // 429, not 409 — the 429 guard short-circuited before the envelope read.
    expect(res2.status).toBe(429);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('pre-start hard 403: resolveAgentSandbox {ok:false} without soft flags + no HTTP → 403 before start()', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    servicesState.resolveSandbox.resolveAgentSandbox = vi.fn(async () => ({
      ok: false as const,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
    }));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(403);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('pre-start soft: selectionRequired → start is called (soft-path gate passes)', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    servicesState.resolveSandbox.resolveAgentSandbox = vi.fn(async () => ({
      ok: false as const,
      selectionRequired: true as const,
      response: Response.json({ error: 'Selection required' }, { status: 403 }),
    }));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('start() args carry NO functions/execute closures — no tools key; scope + persistRunBind are plain values only', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(startMock).toHaveBeenCalledTimes(1);
    const startArgs = startMock.mock.calls[0][1][0];

    // Deep-verify no functions anywhere in start args (adversarial L1).
    const json = JSON.stringify(startArgs);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(startArgs);

    // NO tools key — tool schemas are assembled in-step.
    expect(parsed.tools).toBeUndefined();

    // scope is plain serializable values only.
    expect(parsed.scope).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1' });
  });
});
