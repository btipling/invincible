import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';

/**
 * Route tests for backend-agents C14b (#835) — `POST /api/turns` durable-turn
 * start surface. Mocks the SDK `start`, the DI root, `buildToolWorld`, and the
 * workflow entry so the route never enqueues a real Workflow run, opens a DB/
 * Redis connection, or constructs a real persist seam. Covers the matrix rows 1,
 * 2, 3, 5, 6, 7 (row 8 — in-workflow turnRunId derivation — lives in
 * `lib/workflows/turnWorkflow.test.ts`). No real `createDbConnection` / PGlite —
 * everything is injected through the mocked composition root (DI/cost gate).
 */
describe('POST /api/turns', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let startMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let persistSeamWireMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let toolWorldWireMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let turnWorkflowMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildToolWorldMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parseAgentBodyMock: any;

  function resetServiceState() {
    delete servicesState.createPersistStepSeam;
    delete servicesState.harnessSessionsRedis;
    delete servicesState.resolveInferenceForRequest;
    delete servicesState.serverSecrets;
    delete servicesState.userSkills;
    delete servicesState.userPersonas;
    delete servicesState.userPreferredSandbox;
    delete servicesState.userMcpServers;
    delete servicesState.createHttpRunner;
  }

  function mockDi() {
    resetServiceState();
    servicesState.createPersistStepSeam = vi.fn(() => ({
      persist: vi.fn(async () => ({ ok: true as const, status: 'completed' as const })),
    }));
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
    servicesState.serverSecrets = { gatewayKey: undefined };
    servicesState.userSkills = {};
    servicesState.userPersonas = {};
    servicesState.userPreferredSandbox = {};
    servicesState.userMcpServers = {
      loadEnabledUserMcpSecrets: vi.fn(async () => ({ ok: true as const, value: [] })),
      setUserMcpServerLastError: vi.fn(),
    };
    servicesState.createHttpRunner = vi.fn();
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
  }

  function mockBoundary() {
    persistSeamWireMock = vi.fn();
    toolWorldWireMock = vi.fn();
    vi.doMock('../../../lib/workflows/persistStep', () => ({
      setPersistSeamResolver: persistSeamWireMock,
    }));
    vi.doMock('../../../lib/workflows/toolExecuteStep', () => ({
      setToolWorldResolver: toolWorldWireMock,
    }));
    turnWorkflowMock = vi.fn(async () => ({ status: 'completed' }));
    vi.doMock('../../../lib/workflows/turnWorkflow', () => ({
      turnWorkflow: turnWorkflowMock,
    }));
  }

  function mockWorld() {
    const signal = new AbortController().signal;
    buildToolWorldMock = vi.fn(async () => ({
      registry: { find_skill: {} },
      secrets: [] as Array<string | undefined | null>,
      redactList: [] as string[],
      signal,
      mcpClose: undefined,
    }));
    vi.doMock('../../../lib/agent/buildToolWorld', () => ({
      buildToolWorld: buildToolWorldMock,
    }));
  }

  function mockMisc() {
    // parseAgentBody is mocked so the route test controls the optional
    // `sessionId` (the real one imports parseChatBody from lib/chatServer — the
    // route guard is what rejects an absent sessionId, so we drive it directly).
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
    vi.doMock('../../../lib/mcp/client', () => ({
      buildUserMcpTools: vi.fn(async () => ({
        tools: {},
        secretsToRedact: [] as string[],
        close: vi.fn(async () => {}),
        connectedSlugs: [] as string[],
        skipped: [] as Array<{ slug: string; reason: string }>,
      })),
    }));
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(),
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
    vi.doMock('workflow/api', () => ({ start: startMock, getRun: vi.fn() }));
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
    mockBoundary();
    mockWorld();
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
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/agent/buildToolWorld');
    vi.doUnmock('../../../lib/workflows/persistStep');
    vi.doUnmock('../../../lib/workflows/toolExecuteStep');
    vi.doUnmock('../../../lib/workflows/turnWorkflow');
    vi.doUnmock('../../../lib/chatServer');
    vi.doUnmock('../../../lib/mcp/client');
    vi.doUnmock('../../../lib/tenancy/harnessSessionsRedis');
    vi.doUnmock('workflow/api');
    resetServiceState();
  });

  it('row 1 — authed valid sessionId+prompt → start called; returns {runId} + x-workflow-run-id', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();

    // Record the exact call order so we can prove both step-seam resolvers are
    // INSTALLED before the run is enqueued (boundary wiring before start()).
    const order: string[] = [];
    persistSeamWireMock.mockImplementation(() => {
      order.push('persist-seam-wire');
    });
    toolWorldWireMock.mockImplementation(() => {
      order.push('tool-world-wire');
    });
    startMock.mockImplementation(async () => {
      order.push('start');
      return { runId: 'wf_turn_123', getReadable: vi.fn(() => new ReadableStream()) };
    });

    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(await res.json()).toEqual({ runId: 'wf_turn_123' });

    expect(startMock).toHaveBeenCalledTimes(1);
    const [wf, args] = startMock.mock.calls[0];
    expect(wf).toBe(turnWorkflowMock);
    expect(args).toEqual([
      { userMessage: 'hi', tools: { find_skill: {} }, modelId: 'anthropic/claude-a' },
    ]);

    // The persist seam is wired BEFORE start() with the session scope.
    expect(persistSeamWireMock).toHaveBeenCalledTimes(1);
    const seamResolver = persistSeamWireMock.mock.calls[0][0];
    expect(servicesState.createPersistStepSeam).not.toHaveBeenCalled();
    seamResolver();
    expect(servicesState.createPersistStepSeam).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's1',
    });

    // Both resolvers are installed before the run is enqueued.
    expect(order).toEqual(['persist-seam-wire', 'tool-world-wire', 'start']);
  });

  it('row 2 — missing sessionId → 400 (parseAgentBody would pass; route guard rejects), no start', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sessionId is required/i);
    expect(startMock).not.toHaveBeenCalled();
    expect(toolWorldWireMock).not.toHaveBeenCalled();
    expect(persistSeamWireMock).not.toHaveBeenCalled();
  });

  it('row 3 — start throws → 503 fail-closed, no /api/agent fallback path reached', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    startMock.mockRejectedValue(new Error('Workflow feature is not enabled for this project.'));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/fail closed/i);
    // The run was NOT started → no SSE/JSON runId body is produced.
    expect(body.error).not.toMatch(/wf_turn_123/);
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
    expect(persistSeamWireMock).not.toHaveBeenCalled();
    expect(toolWorldWireMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });
});
