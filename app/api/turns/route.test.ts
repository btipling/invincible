import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_ERROR } from '../../../lib/tenancy/errors';

/**
 * Route tests for backend-agents C14b (#835) — `POST /api/turns` durable-turn
 * start surface. Mocks the SDK `start`, the DI root, and the workflow entry
 * so the route never enqueues a real Workflow run, opens a DB/Redis connection,
 * or constructs a real persist seam. Covers the matrix rows 1, 2, 3, 5, 6, 7
 * (row 8 — in-workflow turnRunId derivation — lives in
 * `lib/workflows/turnWorkflow.test.ts`).
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
  let turnWorkflowMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parseAgentBodyMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveSessionStoreMock: any;

  function resetServiceState() {
    delete servicesState.harnessSessionsRedis;
    delete servicesState.resolveInferenceForRequest;
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
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: { close: async () => {} },
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
        readEnvelope: vi.fn(async () => ({
          meta: {
            logicalCwd: 'app',
            activeSandboxId: 'sb_bind',
          },
        })),
      },
    }));
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: resolveSessionStoreMock,
      sessionKeyFor: () => ({ tenantId: '', userId: '', sessionId: '' }),
    }));
    vi.doMock('../../../lib/sessions/sessionStore', () => ({
      isEnvelopeStore: () => true,
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
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/workflows/turnWorkflow');
    vi.doUnmock('../../../lib/chatServer');
    vi.doUnmock('../../../lib/tenancy/harnessSessionsRedis');
    vi.doUnmock('../../../lib/sessions/sessionStore');
    vi.doUnmock('workflow/api');
    resetServiceState();
  });

  it('row 1 — authed valid sessionId+prompt → start called with serializable-only args (scope, modelId, userMessage, persistRunBind); NO tools key; returns {runId} + x-workflow-run-id', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-workflow-run-id')).toBe('wf_turn_123');
    expect(await res.json()).toEqual({ runId: 'wf_turn_123' });

    expect(startMock).toHaveBeenCalledTimes(1);
    const [wf, argsArr] = startMock.mock.calls[0];
    expect(wf).toBe(turnWorkflowMock);

    // start() args = exactly ONE TurnWorkflowArgs object
    const startArgs = argsArr[0];
    expect(startArgs.userMessage).toBe('hi');
    expect(startArgs.modelId).toBe('anthropic/claude-a');
    // scope must be present (serializable, no closures)
    expect(startArgs.scope).toEqual({ tenantId: 't1', userId: 'u1', sessionId: 's1' });
    // NO tools key — tool schemas are assembled in-step via the shared helper
    expect(startArgs.tools).toBeUndefined();
    // persistRunBind optionally present from envelope meta
    expect(startArgs.persistRunBind).toEqual({ cwd: 'app', activeSandboxId: 'sb_bind' });
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
    expect(startMock).not.toHaveBeenCalled();
  });

  it('pre-start hard 403: resolveAgentSandbox {ok:false} without soft flags + no HTTP → 403 before start()', async () => {
    standardHarness();
    mockAuthedSession();
    mockStart();
    // Override the default resolveAgentSandbox in servicesState to return
    // a hard deny (no softContinue, no selectionRequired).
    servicesState.resolveSandbox.resolveAgentSandbox = vi.fn(async () => ({
      ok: false as const,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
    }));
    ({ POST } = await import('./route'));

    const res = await postJson({ prompt: 'hi', sessionId: 's1' });

    expect(res.status).toBe(403);
    // start was NOT called — doomed run never enqueued.
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

    // Soft-path: selectionRequired → proceed. 200 (or SSE), not 403.
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
