import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_ERROR,
  SANDBOX_FORBIDDEN_ERROR,
  SANDBOX_SELECTION_REQUIRED_ERROR,
  WORKSPACE_INSTANCE_REQUIRED_ERROR,
} from '../../../lib/tenancy/errors';
import { parseJsonAgentBody } from '../../../lib/agentApi';

/**
 * Route tests import the handler after env is set.
 * We mock runAgent / resolve / MCP to avoid real Gateway / DB.
 */
describe('POST /api/agent', () => {
  const originalEnv = { ...process.env };

  /**
   * Phase-1 DI (#440): the route builds services from the composition root
   * (`createProdServices`). Tests mock the service slices via `lib/di` and the
   * active `servicesState`, so mocked methods intercept as they do in prod.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesState: Record<string, any> = {};

  function mockDi() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).soleMembership = servicesState.soleMembership ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).resolveInferenceForRequest =
      servicesState.resolveInferenceForRequest ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userGithubToken = servicesState.userGithubToken ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).resolveSandbox = servicesState.resolveSandbox ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userMcpServers = servicesState.userMcpServers ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).userSandboxInstance =
      servicesState.userSandboxInstance ?? {
        loadInstance: vi.fn(async () => ({ ok: true as const, value: null })),
      };
    // Phase-2 DI (#439): the route reads `serverSecrets` and builds the hop-B HTTP
    // runner via `createHttpRunner` from the root. Default serverSecrets to empty
    // (no gateway-token redaction) unless a test overrides them. Phase 3 (#476):
    // `ServerSecrets` has no env `sandboxToken` anymore.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (servicesState as any).serverSecrets =
      servicesState.serverSecrets ?? { gatewayKey: undefined };
    vi.doMock('../../../lib/di', () => ({
      createProdServices: () => servicesState,
      createScriptConnection: vi.fn(),
    }));
    vi.doMock('../../../lib/gateway/modelCatalog', () => ({
      effortValuesForModel: vi.fn(async () => []),
    }));
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    delete servicesState.resolveInferenceForRequest;
    delete servicesState.userGithubToken;
    delete servicesState.resolveSandbox;
    delete servicesState.userMcpServers;
    delete servicesState.userSandboxInstance;
    delete servicesState.soleMembership;
    delete servicesState.serverSecrets;
    delete servicesState.createHttpRunner;
    delete servicesState.userPersonas;
    delete servicesState.harnessSessionsRedis;
    delete servicesState.userSkills;
    vi.doUnmock('../../../lib/di');
    vi.doUnmock('../../../lib/gateway/modelCatalog');
    vi.doUnmock('../../../lib/agent/runAgent');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/mcp/client');
    vi.doUnmock('../../../lib/agent/vercelSandboxHttpRunner');
    vi.doUnmock('../../../lib/agent/httpFetchTools');
    vi.doUnmock('../../../lib/agent/builtinHttpConfig');
    vi.doUnmock('../../../lib/tenancy/harnessSessionsRedis');
  });

  async function loadRoute() {
    return import('./route');
  }

  function mockAuthedSession(userId = 'user-1') {
    mockDi();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: userId, email: 'a@b.c' },
      })),
    }));
  }

  function mockUnauthed() {
    mockDi();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: AUTH_REQUIRED_ERROR },
          { status: 401 },
        ),
      })),
    }));
  }

  function mockByokOk(overrides: Record<string, unknown> = {}) {
    servicesState.resolveInferenceForRequest = {
      resolveByokForRequest: vi.fn(async () => ({
        ok: true as const,
        modelId: 'anthropic/claude-a',
        provider: 'anthropic',
        credentials: { apiKey: 'sk-byok-test' },
        only: ['anthropic'] as [string],
        byok: { anthropic: [{ apiKey: 'sk-byok-test' }] },
        secretId: 'sec-1',
        secretsToRedact: ['sk-byok-test'],
        ...overrides,
      })),
    };
  }

  function mockByokFail(
    reason: 'forbidden' | 'unavailable' | 'model_invalid' = 'forbidden',
  ) {
    servicesState.resolveInferenceForRequest = {
      resolveByokForRequest: vi.fn(async () => ({
        ok: false as const,
        reason,
      })),
    };
  }

  function mockMcpEmpty() {
    const close = vi.fn(async () => {});
    const buildUserMcpTools = vi.fn(async () => ({
      tools: {},
      secretsToRedact: [] as string[],
      close,
      connectedSlugs: [] as string[],
      skipped: [] as Array<{ slug: string; reason: string }>,
    }));
    vi.doMock('../../../lib/mcp/client', () => ({ buildUserMcpTools }));
    return { close, buildUserMcpTools };
  }


  function mockHttpInstance(
    value:
      | null
      | { status: 'running' | 'stopped' | 'error'; vercelName: string } = {
        status: 'running',
        vercelName: 'inv-http-test',
      },
  ) {
    const loadInstance = vi.fn(async () =>
      value == null
        ? { ok: true as const, value: null }
        : {
            ok: true as const,
            value: {
              userId: 'user-1',
              purpose: 'http' as const,
              tenantId: 't1',
              catalogSandboxId: null,
              vercelName: value.vercelName,
              image: 'vercel/sandbox/universal:latest',
              status: value.status,
              lastError: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
    );
    servicesState.userSandboxInstance = { loadInstance };
    return { loadInstance };
  }

  function mockGithubToken(value: string | null = null) {
    const decryptUserGithubTokenForServer = vi.fn(async () =>
      value
        ? { ok: true as const, value }
        : { ok: true as const, value: null },
    );
    servicesState.userGithubToken = { decryptUserGithubTokenForServer };
    return { decryptUserGithubTokenForServer };
  }

  function mockResolveSandbox(valueOverrides: Record<string, unknown> = {}) {
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true,
      value: {
        client: fakeClient,
        permissions: { canRead: true, canWrite: true },
        secrets: [] as string[],
        sandboxId: 'sbx-1',
        tenantId: 'ten-1',
        backend: 'vercel',
        resolvedImage: 'vercel/sandbox/universal:latest',
        baseUrl: 'http://sandbox.example',
        ...valueOverrides,
      },
    }));
    servicesState.resolveSandbox = { resolveAgentSandbox };
    return { fakeClient, resolveAgentSandbox };
  }

  function mockResolveSandboxOk(valueOverrides: Record<string, unknown> = {}) {
    return mockResolveSandbox(valueOverrides);
  }

  /** Set resolveAgentSandbox to a custom mock (per-test). */
  function mockResolveSandboxWith(
    resolver: (userId: string, deps: Record<string, unknown>) => unknown,
  ) {
    const resolveAgentSandbox = vi.fn(async (uid: string, ds: Record<string, unknown>) =>
      resolver(uid, ds),
    );
    servicesState.resolveSandbox = { resolveAgentSandbox };
    return { resolveAgentSandbox };
  }

  it('returns 500 when gateway key missing', async () => {
    mockAuthedSession();
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';
    delete process.env.AI_GATEWAY_API_KEY;
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

  it('returns 400 on bad body', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
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

  it('returns 400 for host-absolute cwd', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(),
      runAgentStream: vi.fn(),
    }));
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', cwd: '/etc' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cwd|absolute/i);
  });

  it('passes initialCwd and returns cwd from runAgent', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async (arg: { initialCwd?: string }) => ({
      text: 'ok',
      toolTrace: [],
      cwd: arg.initialCwd ?? '.',
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));
    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', cwd: 'invincible' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; cwd?: string };
    expect(body.text).toBe('ok');
    expect(body.cwd).toBe('invincible');
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]?.[0] as { initialCwd?: string };
    expect(arg.initialCwd).toBe('invincible');
  });

  it('omitted body on glm-5.3-flash passes reasoning low to runAgent (plan #897 DoD)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      mockAuthedSession();
      mockMcpEmpty();
      mockByokOk({ modelId: 'zai/glm-5.3-flash', provider: 'zai' });
      mockGithubToken();
      mockResolveSandboxOk();
      process.env.AI_GATEWAY_API_KEY = 'gw-key';
      const runAgent = vi.fn(async (_arg: { modelId?: string; reasoning?: string }) => ({
        text: 'ok',
        toolTrace: [],
        cwd: '.',
      }));
      vi.doMock('../../../lib/agent/runAgent', () => ({
        runAgent,
        runAgentStream: vi.fn(),
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
      expect(runAgent).toHaveBeenCalled();
      const arg = runAgent.mock.calls[0]?.[0] as { modelId?: string; reasoning?: string };
      expect(arg.modelId).toBe('zai/glm-5.3-flash');
      expect(arg.reasoning).toBe('low');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('non-empty Gateway list [high,xhigh] passes reasoning high to runAgent (adversarial-review #899)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      mockAuthedSession();
      mockMcpEmpty();
      mockByokOk({ modelId: 'zai/glm-5.2', provider: 'zai' });
      mockGithubToken();
      mockResolveSandboxOk();
      process.env.AI_GATEWAY_API_KEY = 'gw-key';
      vi.doMock('../../../lib/gateway/modelCatalog', () => ({
        effortValuesForModel: vi.fn(async () => ['high', 'xhigh']),
      }));
      const runAgent = vi.fn(async (_arg: { modelId?: string; reasoning?: string }) => ({
        text: 'ok',
        toolTrace: [],
        cwd: '.',
      }));
      vi.doMock('../../../lib/agent/runAgent', () => ({
        runAgent,
        runAgentStream: vi.fn(),
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
      const arg = runAgent.mock.calls[0]?.[0] as { modelId?: string; reasoning?: string };
      expect(arg.modelId).toBe('zai/glm-5.2');
      expect(arg.reasoning).toBe('high');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('body max + luna list coerces to xhigh (#911 adversarial-review)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      mockAuthedSession();
      mockMcpEmpty();
      mockByokOk({ modelId: 'openai/gpt-5.6-luna', provider: 'openai' });
      mockGithubToken();
      mockResolveSandboxOk();
      process.env.AI_GATEWAY_API_KEY = 'gw-key';
      vi.doMock('../../../lib/gateway/modelCatalog', () => ({
        effortValuesForModel: vi.fn(async () => [
          'none',
          'low',
          'medium',
          'high',
          'xhigh',
        ]),
      }));
      const runAgent = vi.fn(async (_arg: { modelId?: string; reasoning?: string }) => ({
        text: 'ok',
        toolTrace: [],
        cwd: '.',
      }));
      vi.doMock('../../../lib/agent/runAgent', () => ({
        runAgent,
        runAgentStream: vi.fn(),
      }));
      const { POST } = await import('./route');
      const res = await POST(
        new Request('http://localhost/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi', reasoning: 'max' }),
        }),
      );
      expect(res.status).toBe(200);
      const arg = runAgent.mock.calls[0]?.[0] as { modelId?: string; reasoning?: string };
      expect(arg.modelId).toBe('openai/gpt-5.6-luna');
      expect(arg.reasoning).toBe('xhigh');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('body max + glm published list coerces to xhigh', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      mockAuthedSession();
      mockMcpEmpty();
      mockByokOk({ modelId: 'zai/glm-5.3-flash', provider: 'zai' });
      mockGithubToken();
      mockResolveSandboxOk();
      process.env.AI_GATEWAY_API_KEY = 'gw-key';
      vi.doMock('../../../lib/gateway/modelCatalog', () => ({
        effortValuesForModel: vi.fn(async () => ['low', 'high', 'xhigh']),
      }));
      const runAgent = vi.fn(async (_arg: { modelId?: string; reasoning?: string }) => ({
        text: 'ok',
        toolTrace: [],
        cwd: '.',
      }));
      vi.doMock('../../../lib/agent/runAgent', () => ({
        runAgent,
        runAgentStream: vi.fn(),
      }));
      const { POST } = await import('./route');
      const res = await POST(
        new Request('http://localhost/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi', reasoning: 'max' }),
        }),
      );
      expect(res.status).toBe(200);
      const arg = runAgent.mock.calls[0]?.[0] as { modelId?: string; reasoning?: string };
      expect(arg.modelId).toBe('zai/glm-5.3-flash');
      expect(arg.reasoning).toBe('xhigh');
    } finally {
      if (prev === undefined) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('passes a bounded provider usage summary through on the JSON result (plan #539 / #327)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({
      text: 'done',
      toolTrace: [],
      cwd: '.',
      usage: { source: 'provider', prompt: 300, completion: 100, total: 400 },
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
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
    const body = (await res.json()) as { text: string; usage?: unknown };
    expect(body.text).toBe('done');
    expect(body.usage).toEqual({
      source: 'provider',
      prompt: 300,
      completion: 100,
      total: 400,
    });
  });

  it('omits usage from the JSON result when runAgent reports none', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({ text: 'done', toolTrace: [], cwd: '.' }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
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
    const body = (await res.json()) as { text: string; usage?: unknown };
    expect(body.text).toBe('done');
    expect(body.usage).toBeUndefined();
  });

  it('forwards the per-binding workspaceRoot + bind projection into runAgent when resolve ok', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    type RunArg = {
      workspaceRoot?: string | null;
      sandboxClient?: unknown;
      bind?: {
        backend: string;
        sandboxId: string;
        name: string;
        slug: string;
        status: string;
        image?: string | null;
      };
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'ok',
      toolTrace: [],
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          backend: 'vercel' as const,
          name: 'prod',
          slug: 'prod',
          status: 'active',
          resolvedImage: 'vercel/sandbox/universal:latest',
          workspaceRoot: '/vercel/workspace',
        },
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    expect(arg).toBeDefined();
    expect(arg!.workspaceRoot).toBe('/vercel/workspace');
    // bind is the six-field non-secret projection — never baseUrl / workspaceRoot / secrets / client
    expect(arg!.bind).toEqual({
      backend: 'vercel',
      sandboxId: 'sbx-1',
      name: 'prod',
      slug: 'prod',
      status: 'active',
      image: 'vercel/sandbox/universal:latest',
    });
    expect(arg!.bind).not.toHaveProperty('baseUrl');
    expect(arg!.bind).not.toHaveProperty('workspaceRoot');
    expect(arg!.bind).not.toHaveProperty('secrets');
    expect(arg!.bind).not.toHaveProperty('client');
  });

  it('returns 401 with AUTH_REQUIRED_ERROR when unauthenticated', async () => {
    mockUnauthed();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('returns 403 SANDBOX_FORBIDDEN_ERROR when resolve fails', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    mockResolveSandboxWith(() => ({
      ok: false as const,
      response: Response.json({ error: SANDBOX_FORBIDDEN_ERROR }, { status: 403 }),
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SANDBOX_FORBIDDEN_ERROR);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('softContinue + empty MCP + no builtin → 403 WORKSPACE_INSTANCE_REQUIRED (no runAgent)', async () => {
    mockAuthedSession();
    const mcp = mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({
      text: 'should-not-run',
      toolTrace: [],
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        softContinue: true as const,
        response: Response.json(
          { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
          { status: 403 },
        ),
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: WORKSPACE_INSTANCE_REQUIRED_ERROR,
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(mcp.buildUserMcpTools).toHaveBeenCalled();
    // Plan #938 / adversarial #940: working_notes_* are always-on like meta_*
    // and must not substitute for FS/MCP/http on this 403. If the filter
    // dropped, this test would go 200 (notes-only turn hiding the workspace).
  });

  it('softContinue from resolve skips FS tools and still runs agent when MCP tools exist', async () => {
    mockAuthedSession();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';

    type RunArg = {
      skipSandboxTools?: boolean;
      sandboxClient?: unknown;
      secrets: string[];
      prompt: string;
      extraTools?: Record<string, unknown>;
      workspaceRoot?: string | null;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'soft-ok',
      toolTrace: [],
    }));
    const close = vi.fn(async () => {});
    const buildUserMcpTools = vi.fn(async () => ({
      tools: {
        mcp_demo_ping: {
          description: 'ping',
          parameters: {},
          execute: async () => 'pong',
        },
      },
      secretsToRedact: [] as string[],
      close,
      connectedSlugs: ['demo'] as string[],
      skipped: [] as Array<{ slug: string; reason: string }>,
    }));
    vi.doMock('../../../lib/mcp/client', () => ({ buildUserMcpTools }));
    mockByokOk();
    mockGithubToken();
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        softContinue: true as const,
        response: Response.json(
          { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
          { status: 403 },
        ),
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('soft-ok');
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]![0] as RunArg;
    expect(arg.skipSandboxTools).toBe(true);
    expect(arg.sandboxClient).toBeUndefined();
    expect(arg.workspaceRoot).toBeUndefined();
    expect(arg.extraTools).toMatchObject({ mcp_demo_ping: expect.anything() });
    expect(buildUserMcpTools).toHaveBeenCalled();
  });

  it('injects resolved client + BYOK without requiring env SANDBOX_*', async () => {
    mockAuthedSession();
    const mcp = mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
    };
    type RunArg = {
      sandboxClient: unknown;
      secrets: string[];
      permissions: { canRead: boolean; canWrite: boolean };
      prompt: string;
      modelId?: string;
      providerOptions?: {
        gateway?: { only?: unknown; byok?: unknown };
      };
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'from-db-sandbox',
      toolTrace: [],
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: fakeClient,
          permissions: { canRead: true, canWrite: false },
          secrets: ['decrypted-db-token'],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          baseUrl: 'http://sandbox.example',
        },
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'do work' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('from-db-sandbox');
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg!.prompt).toBe('do work');
    expect(arg!.sandboxClient).toBe(fakeClient);
    expect(arg!.secrets).toContain('decrypted-db-token');
    expect(arg!.secrets).toContain('sk-byok-test');
    expect(arg!.permissions).toEqual({ canRead: true, canWrite: false });
    expect(arg!.modelId).toBe('anthropic/claude-a');
    expect(arg!.providerOptions?.gateway?.only).toEqual(['anthropic']);
    expect(arg!.providerOptions?.gateway?.byok).toEqual({
      anthropic: [{ apiKey: 'sk-byok-test' }],
    });
    // Phase 3 (#516): the read-only skill tools are always assembled.
    expect(arg!.extraTools?.find_skill).toBeTruthy();
    expect(arg!.extraTools?.fetch_skill).toBeTruthy();
    expect(mcp.buildUserMcpTools).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(mcp.close).toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('sk-byok-test');
  });

  it('merges MCP extraTools + secrets and closes clients', async () => {
    mockAuthedSession();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    const close = vi.fn(async () => {});
    const mcpTools = {
      mcp_exa__web_search: { execute: async () => 'ok' },
    };
    type RunArg = {
      extraTools?: Record<string, unknown>;
      secrets?: string[];
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'with-mcp',
      toolTrace: [
        {
          name: 'mcp_exa__web_search',
          ok: true,
          summary: 'search ok',
        },
      ],
    }));
    vi.doMock('../../../lib/mcp/client', () => ({
      buildUserMcpTools: vi.fn(async () => ({
        tools: mcpTools,
        secretsToRedact: ['mcp-key-secret-value'],
        close,
        connectedSlugs: ['exa'],
        skipped: [],
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk({ secrets: ['decrypted-db-token'] });
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'search' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    // MCP tools merge in alongside the always-present skill tools (#516).
    expect(arg!.extraTools).toMatchObject(mcpTools);
    expect(arg!.extraTools?.find_skill).toBeTruthy();
    expect(arg!.extraTools?.fetch_skill).toBeTruthy();
    expect(arg!.secrets).toContain('mcp-key-secret-value');
    expect(close).toHaveBeenCalled();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('mcp-key-secret-value');
  });

  it('empty BYOK grants → 403 and runAgent not called', async () => {
    mockAuthedSession();
    const mcp = mockMcpEmpty();
    mockByokFail('forbidden');
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true as const,
      value: {
        client: {},
        permissions: { canRead: true, canWrite: true },
        secrets: [],
        sandboxId: 'sbx-1',
        tenantId: 'ten-1',
        baseUrl: 'http://sandbox.example',
      },
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox,
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Inference access denied.');
    expect(runAgent).not.toHaveBeenCalled();
    expect(resolveAgentSandbox).not.toHaveBeenCalled();
    expect(mcp.buildUserMcpTools).not.toHaveBeenCalled();
  });

  it('returns 499 when runAgent aborts', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
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

  it('grant deny + running HTTP instance → not 403; http tools only', async () => {
    mockAuthedSession();
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'running', vercelName: 'inv-http-user1' });
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';

    const closeHttp = vi.fn(async () => {});
    type HttpOnlyRunArg = {
      skipSandboxTools?: boolean;
      extraTools?: Record<string, unknown>;
      prompt: string;
    };
    const runAgent = vi.fn(async (_arg: HttpOnlyRunArg) => ({
      text: 'web only',
      toolTrace: [],
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: 'Sandbox access denied.' },
          { status: 403 },
        ),
      })),
    };
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/httpFetchTools', () => ({
      createHttpFetchTools: vi.fn(() => ({
        http_get: { description: 'get', execute: async () => 'ok' },
      })),
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg!.skipSandboxTools).toBe(true);
    expect(arg!.extraTools?.http_get).toBeTruthy();
    expect(createRunner).toHaveBeenCalledWith({ name: 'inv-http-user1' });
    expect(closeHttp).toHaveBeenCalled();
  });

  it('grant deny, no HTTP instance → hard 403 grant', async () => {
    mockAuthedSession();
    mockByokOk();
    mockGithubToken();
    mockHttpInstance(null);
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: SANDBOX_FORBIDDEN_ERROR },
          { status: 403 },
        ),
      })),
    };
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SANDBOX_FORBIDDEN_ERROR });
    expect(createRunner).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('grant deny, loadInstance error (ok:false) → hard 403 grant', async () => {
    mockAuthedSession();
    mockByokOk();
    mockGithubToken();
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    // Simulate a transient DB read error — loadInstance returns {ok:false}.
    servicesState.userSandboxInstance = {
      loadInstance: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable' as const,
      })),
    };
    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: SANDBOX_FORBIDDEN_ERROR },
          { status: 403 },
        ),
      })),
    };
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SANDBOX_FORBIDDEN_ERROR });
    // httpAttachName stayed null (loadInstance returned !ok), so no runner was
    // created and the soft-path was not entered.
    expect(createRunner).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('FS ok, stopped HTTP instance → omit http tools; runAgent still runs', async () => {
    mockAuthedSession();
    const mcp = mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'stopped', vercelName: 'inv-http-stopped' });
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const sandboxClient = { close: vi.fn(async () => {}) };
    type RunArg = {
      skipSandboxTools?: boolean;
      sandboxClient?: unknown;
      extraTools?: Record<string, unknown>;
      prompt: string;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'fs only',
      toolTrace: [],
    }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: sandboxClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          baseUrl: 'http://sandbox.example',
        },
      })),
    };
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: vi.fn(async () => {}),
    }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg!.sandboxClient).toBe(sandboxClient);
    expect(arg!.extraTools?.http_get).toBeUndefined();
    expect(createRunner).not.toHaveBeenCalled();
    void mcp;
  });

  it('FS ok, error HTTP status → omit http tools; runAgent still runs', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'error', vercelName: 'inv-http-err' });
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    type RunArg = {
      sandboxClient?: unknown;
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'fs only',
      toolTrace: [],
    }));
    const sandboxClient = { close: vi.fn(async () => {}) };
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: sandboxClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          baseUrl: 'http://sandbox.example',
        },
      })),
    };
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg!.sandboxClient).toBe(sandboxClient);
    expect(arg!.extraTools?.http_get).toBeUndefined();
    expect(createRunner).not.toHaveBeenCalled();
  });

  it('FS ok, running HTTP instance → http tools + FS; attach name from instance', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'running', vercelName: '  inv-http-both  ' });
    process.env.AI_GATEWAY_API_KEY = 'gw-key';

    const closeHttp = vi.fn(async () => {});
    type RunArg = {
      sandboxClient?: unknown;
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'fs+http',
      toolTrace: [],
    }));
    const sandboxClient = { close: vi.fn(async () => {}) };
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: sandboxClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          baseUrl: 'http://sandbox.example',
        },
      })),
    };
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    servicesState.createHttpRunner = createRunner;
    vi.doMock('../../../lib/agent/httpFetchTools', () => ({
      createHttpFetchTools: vi.fn(() => ({
        http_get: { description: 'get', execute: async () => 'ok' },
      })),
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg!.sandboxClient).toBe(sandboxClient);
    expect(arg!.extraTools?.http_get).toBeTruthy();
    expect(createRunner).toHaveBeenCalledWith({ name: 'inv-http-both' });
    expect(closeHttp).toHaveBeenCalled();
  });

  it('finally closes http runner when runAgent throws', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    mockHttpInstance({ status: 'running', vercelName: 'inv-http-host' });
    process.env.AI_GATEWAY_API_KEY = 'gw-key';

    const closeHttp = vi.fn(async () => {});
    servicesState.createHttpRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    vi.doMock('../../../lib/agent/httpFetchTools', () => ({
      createHttpFetchTools: vi.fn(() => ({
        http_get: { description: 'get', execute: async () => 'ok' },
      })),
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => {
        throw new Error('model boom');
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
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(closeHttp).toHaveBeenCalled();
  });

  it('JSON finally closes vercel sandbox client close()', async () => {
    mockAuthedSession();
    const mcp = mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const closeSandbox = vi.fn(async () => {});
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: closeSandbox,
    };
    const runAgent = vi.fn(async () => ({ text: 'ok', toolTrace: [] }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: fakeClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-v',
          tenantId: 'ten-1',
          backend: 'vercel' as const,
          resolvedImage: 'vercel/sandbox/universal:latest',
        },
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({ runAgent }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalled();
    expect(closeSandbox).toHaveBeenCalledTimes(1);
    void mcp;
  });

  it('stream start finally closes sandbox client', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const closeSandbox = vi.fn(async () => {});
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: closeSandbox,
    };
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: fakeClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-v',
          tenantId: 'ten-1',
          backend: 'vercel' as const,
          resolvedImage: 'vercel/sandbox/universal:latest',
        },
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(),
      runAgentStream: vi.fn(async (_p, handlers: { onEvent: (e: unknown) => Promise<void> }) => {
        await handlers.onEvent({ type: 'text', text: 'hi' });
        await handlers.onEvent({ type: 'done' });
      }),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    // Drain stream so start() finally runs
    await res.text();
    expect(closeSandbox).toHaveBeenCalledTimes(1);
  });

  it('stream cancel closes sandbox client', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';

    const closeSandbox = vi.fn(async () => {});
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: closeSandbox,
    };

    let releaseStream!: () => void;
    const gate = new Promise<void>((r) => {
      releaseStream = r;
    });

    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: fakeClient,
          permissions: { canRead: true, canWrite: true },
          secrets: [] as string[],
          sandboxId: 'sbx-v',
          tenantId: 'ten-1',
          backend: 'vercel' as const,
          resolvedImage: 'vercel/sandbox/universal:latest',
        },
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(),
      runAgentStream: vi.fn(async () => {
        await gate;
      }),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    await res.body!.cancel();
    // cancel() is async — wait until close runs (not a fixed sleep).
    const deadline = Date.now() + 2000;
    while (!closeSandbox.mock.calls.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(closeSandbox).toHaveBeenCalled();
    releaseStream();
  });

  it('injects GitHub PAT into resolveAgentSandbox execEnv and secrets', async () => {
    mockAuthedSession();
    mockByokOk();
    mockMcpEmpty();
    mockGithubToken('ghp_pat_secret_value');
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true as const,
      value: {
        client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
        permissions: { canRead: true, canWrite: true },
        secrets: ['decrypted-db-token'],
        sandboxId: 'sb-1',
        tenantId: 't-1',
        backend: 'byo' as const,
        baseUrl: 'http://sb',
        resolvedImage: null,
      },
    }));
    servicesState.resolveSandbox = { resolveAgentSandbox };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async (arg: { secrets?: string[] }) => ({
        text: 'ok',
        toolTrace: [],
      })),
      runAgentStream: vi.fn(),
    }));
    vi.doMock('../../../lib/agent/builtinHttpConfig', () => ({
      resolveBuiltinHttpConfig: () => ({
        timeoutMs: 120_000,
        maxBytes: 2_097_152,
        sandboxTimeoutMs: 1_800_000,
      }),
    }));

    const { POST } = await loadRoute();
    const { runAgent } = await import('../../../lib/agent/runAgent');
    const req = new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    const reqSignal = req.signal;
    const res = await POST(req);
    expect(res.status).toBe(200);
    // The 3rd arg is the request abort signal the route forwards to the health
    // probe (run AFTER the DB connection is closed), so an aborted request
    // cancels the probe immediately.
    expect(resolveAgentSandbox).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        execEnv: {
          GH_TOKEN: 'ghp_pat_secret_value',
          GITHUB_TOKEN: 'ghp_pat_secret_value',
        },
      }),
      expect.objectContaining({ signal: reqSignal }),
    );
    const arg = vi.mocked(runAgent).mock.calls[0]?.[0] as { secrets?: string[] };
    expect(arg.secrets).toContain('ghp_pat_secret_value');
    expect(arg.secrets).toContain('decrypted-db-token');
  });

  it('omits execEnv when GitHub token unset', async () => {
    mockAuthedSession();
    mockByokOk();
    mockMcpEmpty();
    mockGithubToken(null);
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true as const,
      value: {
        client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
        permissions: { canRead: true, canWrite: true },
        secrets: [],
        sandboxId: 'sb-1',
        tenantId: 't-1',
        backend: 'vercel' as const,
        resolvedImage: 'img',
      },
    }));
    servicesState.resolveSandbox = { resolveAgentSandbox };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'ok', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));
    vi.doMock('../../../lib/agent/builtinHttpConfig', () => ({
      resolveBuiltinHttpConfig: () => ({
        timeoutMs: 120_000,
        maxBytes: 2_097_152,
        sandboxTimeoutMs: 1_800_000,
      }),
    }));

    const { POST } = await loadRoute();
    const req = new Request('http://localhost/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    const reqSignal = req.signal;
    await POST(req);
    // Full 3-arg call: deps + the forwarded request abort signal.
    expect(resolveAgentSandbox).toHaveBeenCalledWith(
      'user-1',
      {},
      expect.objectContaining({ signal: reqSignal }),
    );
  });

  it('injects a persona preamble when a personaId is bound (phase 3 #488)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    servicesState.userPersonas = {
      getPersonaById: vi.fn(async () => ({
        ok: true,
        value: { id: 'pers_1', body: 'Always use tabs.' },
      })),
    };
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true, value: 'tenant1' })),
    };
    type RunArg = { personaPreamble?: string; prompt?: string };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'ok', toolTrace: [] }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', personaId: 'pers_1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    // The route passes the resolved snapshot text as `personaPreamble`; the
    // `<persona_standing_orders>` wrapper is added by runAgent's
    // resolveSystem (covered in lib/agent/runAgent.test.ts). A trailing
    // <reminder> is appended to the user prompt.
    expect(arg.personaPreamble).toBe('Always use tabs.');
    expect(arg.prompt).toContain('hi');
    expect(arg.prompt).toContain('<reminder>');
    expect(arg.prompt).toContain('<persona_standing_orders>');
    expect(arg.prompt).toContain('Follow them before any tool use');
    expect(arg.prompt).not.toContain('meta_persona_read');
  });

  it('no persona preamble when no sessionId/personaId (behaviour identical to today)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const userPersonas = vi.fn();
    servicesState.userPersonas = { getPersonaById: userPersonas };
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(),
    };
    type RunArg = { personaPreamble?: string; prompt?: string };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'ok', toolTrace: [] }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    expect(arg.personaPreamble).toBeUndefined();
    expect(arg.prompt).toBe('hi');
    expect(arg.prompt).not.toContain('<reminder>');
    expect(userPersonas).not.toHaveBeenCalled();
  });

  it('plan #938 / adversarial #940 — folds notesPreamble from the envelope (stores-absent; persona/skills not required)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      get: vi.fn(),
      put: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      readEnvelope: vi.fn(async () => ({
        id: 'sess_notes',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { workingNotes: 'finding: fold even without persona/skills stores' },
      })),
      upsertEnvelope: vi.fn(),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    type RunArg = { notesPreamble?: string; personaPreamble?: string; skillsPreamble?: string };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'ok', toolTrace: [] }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'what did we conclude?', sessionId: 'sess_notes' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    expect(arg.notesPreamble).toBe('finding: fold even without persona/skills stores');
    expect(arg.personaPreamble).toBeUndefined();
    expect(arg.skillsPreamble).toBeUndefined();
    expect(fakeSessionStore.readEnvelope).toHaveBeenCalled();
  });

  it('strips /slug and folds the catalog skillsPreamble for an attach-with-prose prompt (phase 2 #517, plan #557/#931)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    // Phase-0 ENVELOPE store (adversarial-review H2 seam): the agent mirror
    // readEnvelope/upsertEnvelope so sticky writes land on the envelope key.
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: {},
      })),
      upsertEnvelope: vi.fn(async (_k: unknown, input: { meta?: unknown }) => ({
        status: 'stored',
        envelope: input,
      })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'PLAN BODY: create sections' },
      })),
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
        ],
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
        ],
      })),
    };
    type RunArg = { skillsPreamble?: string; prompt?: string };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'ok', toolTrace: [] }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '/create-plan please scaffold a plan',
          sessionId: 'sess_1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    // /slug stripped from the model prompt; remaining prose preserved.
    expect(arg.prompt).toBe('please scaffold a plan');
    // Catalog folded as the skills preamble (plan #557/#931): the slug +
    // summary line, with NO body — bodies ride the on-demand `fetch_skill`.
    expect(arg.skillsPreamble).toContain('create-plan — Create plan: writes a plan issue');
    expect(arg.skillsPreamble).not.toContain('PLAN BODY');
    // JSON path surfaces the skill outcome as slug-only (never a body), and the
    // server persists the sticky set via the envelope seam (updatedAt unchanged).
    const body = (await res.json()) as { skillEvents?: unknown[]; attachedSkills?: string };
    expect(body.skillEvents).toHaveLength(1);
    expect(body.attachedSkills).toBe('["create-plan"]');
    expect(fakeSessionStore.upsertEnvelope).toHaveBeenCalled();
    const upsert = fakeSessionStore.upsertEnvelope.mock.calls[0]?.[1] as {
      meta?: { attachedSkills?: string };
    };
    expect(upsert.meta?.attachedSkills).toBe('["create-plan"]');
  });

  it('assembles find_skill + fetch_skill into extraTools, bound to the route userId (phase 3 #516)', async () => {
    mockAuthedSession('user-1');
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    servicesState.userSkills = {
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
        ],
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
        ],
      })),
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: {
          id: 's1',
          name: 'Create plan',
          slug: 'create-plan',
          description: '',
          body: 'PLAN BODY',
        },
      })),
    };
    type RunArg = { prompt?: string; extraTools?: Record<string, unknown> };
    const runAgent = vi.fn(async (arg: RunArg) => {
      // The model can call both skill tools in a normal (FS) turn.
      expect(arg.extraTools?.find_skill).toBeTruthy();
      expect(arg.extraTools?.fetch_skill).toBeTruthy();
      return { text: 'ok', toolTrace: [] };
    });
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'list my skills' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    // Bound identity (confused-deputy guard): the tool executes through the
    // route-resolved 'user-1'. A hostile input identity is ignored (covered in
    // lib/agent/skillTools.test.ts); here we confirm the assembled tool resolves
    // against the route userId.
    const list = servicesState.userSkills.listUserSkills as ReturnType<typeof vi.fn>;
    const findSkill = runAgent.mock.calls[0]?.[0]?.extraTools?.find_skill as {
      execute: (i: { query?: string }) => Promise<string>;
    };
    await findSkill.execute({ query: 'plan' });
    expect(list.mock.calls.every((c) => c[0] === 'user-1')).toBe(true);
  });

  it('pure /unskill detach is a NO-MODEL turn (early response, no runAgent)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { attachedSkills: '["create-plan","other"]' },
      })),
      upsertEnvelope: vi.fn(async (_k: unknown, input: { meta?: unknown }) => ({
        status: 'stored',
        envelope: input,
      })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'x' },
      })),
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: [
          { id: 'a', name: 'A', slug: 'create-plan', description: '', updatedAt: new Date(0) },
          { id: 'b', name: 'B', slug: 'other', description: '', updatedAt: new Date(0) },
        ],
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: true as const,
        value: [
          { id: 'a', name: 'A', slug: 'create-plan', description: '', updatedAt: new Date(0) },
          { id: 'b', name: 'B', slug: 'other', description: '', updatedAt: new Date(0) },
        ],
      })),
    };
    const runAgent = vi.fn();
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '/unskill create-plan', sessionId: 'sess_1' }),
      }),
    );
    expect(res.status).toBe(200);
    // No model turn for a pure detach; the confirmation echoes the outcome.
    expect(runAgent).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      text?: string;
      skillEvents?: unknown[];
      attachedSkills?: string;
    };
    expect(body.skillEvents).toHaveLength(1);
    expect(body.text).toMatch(/detach/);
    // The NO-MODEL response still carries the post-detach sticky set so the host
    // folds it (fold-before-persist incl. no-model) → next PUT persists `["other"]`.
    expect(body.attachedSkills).toBe('["other"]');
    // ...and the server persists it via the envelope seam (never legacy put).
    const upsert = fakeSessionStore.upsertEnvelope.mock.calls[0]?.[1] as {
      meta?: { attachedSkills?: string };
    };
    expect(upsert.meta?.attachedSkills).toBe('["other"]');
  });

  it('a FAILED model turn still carries attachedSkills so the host folds before persist', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { attachedSkills: '["create-plan"]' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'BODY' },
      })),
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: [
          { id: 'a', name: 'A', slug: 'create-plan', description: '', updatedAt: new Date(0) },
        ],
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: true as const,
        value: [
          { id: 'a', name: 'A', slug: 'create-plan', description: '', updatedAt: new Date(0) },
        ],
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => {
        throw new Error('inference boom');
      }),
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'keep going', sessionId: 'sess_1' }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    // "fold-before-persist incl. fail/cancel": the stuck set is included on the
    // error body so the host does NOT wipe an attached skill on a model error.
    const body = (await res.json()) as { attachedSkills?: string; error?: string };
    expect(body.error).toBeTruthy();
    expect(body.attachedSkills).toBe('["create-plan"]');
  });

  it('catalog listUserSkills fail-open returns the command-applied sticky set (not omit, not detach-all)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { attachedSkills: '["create-plan"]' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'BODY' },
      })),
      skillExistsBySlug: vi.fn(async () => ({
        ok: true as const,
        value: true,
      })),
      skillExistsBySlugs: vi.fn(async (_uid: string, slugs: readonly string[]) => ({
        ok: true as const,
        value: [...slugs],
      })),
      listUserSkills: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
    };
    type RunArg = { skillsPreamble?: string; prompt?: string };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'ok', toolTrace: [] }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'keep going', sessionId: 'sess_1' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachedSkills?: string; text?: string };
    expect(body.text).toBe('ok');
    // Command-applied set is returned so the host folds it (not omit, not `"[]"`).
    expect(body.attachedSkills).toBe('["create-plan"]');
    expect(fakeSessionStore.upsertEnvelope).toHaveBeenCalled();
    const parsed = parseJsonAgentBody(res, body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.attachedSlugs).toEqual(['create-plan']);
    // Fail-open still injects a slug-only catalog so the model sees identity.
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    expect(arg.skillsPreamble).toContain('create-plan');
  });

  it('catalog listUserSkills fail-open still carries attachedSkills on 502 (no host wipe)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { attachedSkills: '["create-plan"]' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'BODY' },
      })),
      skillExistsBySlug: vi.fn(async () => ({
        ok: true as const,
        value: true,
      })),
      skillExistsBySlugs: vi.fn(async (_uid: string, slugs: readonly string[]) => ({
        ok: true as const,
        value: [...slugs],
      })),
      listUserSkills: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: '', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'keep going', sessionId: 'sess_1' }),
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { attachedSkills?: string; error?: string };
    expect(body.error).toBeTruthy();
    expect(body.attachedSkills).toBe('["create-plan"]');
    expect(fakeSessionStore.upsertEnvelope).toHaveBeenCalled();
    const parsed = parseJsonAgentBody(res, body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.attachedSlugs).toEqual(['create-plan']);
  });

  it('catalog listUserSkills fail-open: skill_attached carries command-applied attachedSlugs', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { attachedSkills: '["kept"]' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'PLAN BODY' },
      })),
      skillExistsBySlug: vi.fn(async () => ({
        ok: true as const,
        value: true,
      })),
      skillExistsBySlugs: vi.fn(async (_uid: string, slugs: readonly string[]) => ({
        ok: true as const,
        value: [...slugs],
      })),
      listUserSkills: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'down',
      })),
    };
    type StreamArg = { skillsPreamble?: string; prompt?: string };
    const runAgentStream = vi.fn(
      async (
        _p: StreamArg,
        handlers: { onEvent: (e: unknown) => Promise<void> },
      ) => {
        await handlers.onEvent({ type: 'done', text: 'ok' });
      },
    );
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(),
      runAgentStream,
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: '/create-plan please scaffold a plan',
          sessionId: 'sess_1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const events: Record<string, unknown>[] = [];
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (!payload) continue;
      events.push(JSON.parse(payload) as Record<string, unknown>);
    }
    const skillEv = events.find((e) => e.type === 'skill_attached');
    expect(skillEv).toBeTruthy();
    expect(skillEv?.slug).toBe('create-plan');
    // Command-applied set includes the new attach + the pre-command sticky.
    // `[]` would fold detach-all; omit would drop the in-turn attach.
    expect(skillEv?.attachedSlugs).toEqual(['kept', 'create-plan']);
    expect(fakeSessionStore.upsertEnvelope).toHaveBeenCalled();
    // Events said attached: the model must still see the slug after strip-/slug.
    const arg = runAgentStream.mock.calls[0]?.[0] as StreamArg;
    expect(arg.prompt).toBe('please scaffold a plan');
    expect(arg.skillsPreamble).toContain('create-plan');
    expect(arg.skillsPreamble).toContain('kept');
  });

  it('SSE skill_attached.attachedSlugs is the sticky persist set (always-on stays out)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    mockResolveSandboxOk();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: {},
      })),
      upsertEnvelope: vi.fn(async (_k: unknown, input: { meta?: unknown }) => ({
        status: 'stored' as const,
        envelope: input,
      })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    servicesState.userSkills = {
      getSkillBySlug: vi.fn(async () => ({
        ok: true as const,
        value: { body: 'PLAN BODY' },
      })),
      listAlwaysOnSkills: vi.fn(async () => ({
        ok: true as const,
        value: ['review'],
      })),
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
          {
            id: 's2',
            name: 'Review',
            slug: 'review',
            description: 'reviews a plan',
            updatedAt: new Date(0),
          },
        ],
      })),
      listUserSkillsBySlugs: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            id: 's1',
            name: 'Create plan',
            slug: 'create-plan',
            description: 'writes a plan issue',
            updatedAt: new Date(0),
          },
          {
            id: 's2',
            name: 'Review',
            slug: 'review',
            description: 'reviews a plan',
            updatedAt: new Date(0),
          },
        ],
      })),
    };
    const runAgentStream = vi.fn(
      async (
        _p: { skillsPreamble?: string },
        handlers: { onEvent: (e: unknown) => Promise<void> },
      ) => {
        await handlers.onEvent({ type: 'done', text: 'ok' });
      },
    );
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(),
      runAgentStream,
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: '/create-plan please scaffold a plan',
          sessionId: 'sess_1',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const events: Record<string, unknown>[] = [];
    for (const block of text.split('\n\n')) {
      const line = block.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (!payload) continue;
      events.push(JSON.parse(payload) as Record<string, unknown>);
    }
    const skillEv = events.find((e) => e.type === 'skill_attached');
    expect(skillEv).toBeTruthy();
    expect(skillEv?.slug).toBe('create-plan');
    // Sticky persist set matches JSON attachedSkills — always-on `review` stays
    // out so a later toggle-off cannot leave it sticky until `/unskill`.
    expect(skillEv?.attachedSlugs).toEqual(['create-plan']);
    expect(skillEv?.attachedSlugs).not.toContain('review');
    expect(fakeSessionStore.upsertEnvelope).toHaveBeenCalled();
    const upsert = fakeSessionStore.upsertEnvelope.mock.calls[0]?.[1] as {
      meta?: { attachedSkills?: string };
    };
    expect(upsert.meta?.attachedSkills).toBe('["create-plan"]');
    // Catalog inject still lists always-on this turn (inject ≠ persist).
    const arg = runAgentStream.mock.calls[0]?.[0] as { skillsPreamble?: string };
    expect(arg.skillsPreamble).toContain('create-plan');
    expect(arg.skillsPreamble).toContain('review');
  });

  it('seeds resolve from the envelope activeSandboxId when a sessionId is present, no body sandboxId (blocker B1 A1)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    // The switch tool persisted `meta.activeSandboxId` on the caller's envelope
    // last turn; the route MUST read it back to seed this turn's resolve.
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { activeSandboxId: 'sbx_env' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    let requestedSandboxId: string | undefined = 'sentinel';
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async (_uid: string, _deps: unknown, opts: {
        requestedSandboxId?: string;
      }) => {
        requestedSandboxId = opts?.requestedSandboxId;
        return {
          ok: true as const,
          value: {
            client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
            permissions: { canRead: true, canWrite: true },
            secrets: [] as string[],
            sandboxId: 'sbx_env',
            tenantId: 'tenant-1',
            backend: 'vercel' as const,
            resolvedImage: 'img',
          },
        };
      }),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'ok', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sessionId: 'sess_1' }),
      }),
    );
    expect(res.status).toBe(200);
    // The envelope bind (persisted by a prior switch) seeds the resolve.
    expect(requestedSandboxId).toBe('sbx_env');
  });

  it('envelope activeSandboxId WINS over the body sandboxId when a sessionId is present (approved decision 3)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const fakeSessionStore = {
      readEnvelope: vi.fn(async () => ({
        id: 'sess_1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1,
        updatedAt: 1,
        meta: { activeSandboxId: 'sbx_env' },
      })),
      upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
    };
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: fakeSessionStore }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    let requestedSandboxId: string | undefined = 'sentinel';
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async (_uid: string, _deps: unknown, opts: {
        requestedSandboxId?: string;
      }) => {
        requestedSandboxId = opts?.requestedSandboxId;
        return {
          ok: true as const,
          value: {
            client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
            permissions: { canRead: true, canWrite: true },
            secrets: [] as string[],
            sandboxId: 'sbx_env',
            tenantId: 'tenant-1',
            backend: 'vercel' as const,
            resolvedImage: 'img',
          },
        };
      }),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'ok', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'hi',
          sessionId: 'sess_1',
          // The host body is a MIRROR (stale pre-turn id); the envelope wins.
          sandboxId: 'sbx_stale_body',
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(requestedSandboxId).toBe('sbx_env');
  });

  it('body sandboxId still seeds resolve when a sessionId is absent (legacy path, no envelope)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    vi.doMock('../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({ ok: true as const, value: undefined }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    servicesState.harnessSessionsRedis = {
      resolveTenantIdForUser: vi.fn(async () => ({ ok: true as const, value: 'tenant-1' })),
    };
    let requestedSandboxId: string | undefined;
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async (_uid: string, _deps: unknown, opts: {
        requestedSandboxId?: string;
      }) => {
        requestedSandboxId = opts?.requestedSandboxId;
        return {
          ok: true as const,
          value: {
            client: { listDir: vi.fn(), close: vi.fn(async () => {}) },
            permissions: { canRead: true, canWrite: true },
            secrets: [] as string[],
            sandboxId: 'sbx_body',
            tenantId: 'tenant-1',
            backend: 'vercel' as const,
            resolvedImage: 'img',
          },
        };
      }),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'ok', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));

    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi', sandboxId: 'sbx_body' }),
      }),
    );
    expect(res.status).toBe(200);
    // No session → no envelope; the body sandboxId is honored (no regression).
    expect(requestedSandboxId).toBe('sbx_body');
  });

  it('selection-required resolve soft-paths to meta sandbox tools, no dead-end 403 (blocker B3)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    type RunArg = {
      skipSandboxTools?: boolean;
      sandboxClient?: unknown;
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({ text: 'picked', toolTrace: [] }));
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        selectionRequired: true as const,
        response: Response.json(
          { error: SANDBOX_SELECTION_REQUIRED_ERROR },
          { status: 403 },
        ),
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'pick a sandbox' }),
      }),
    );
    // No dead-end operator 403: the always-present meta_sandbox_* tools let the
    // agent drive the pick, exactly the case the tool was previously unreachable.
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0] as RunArg;
    expect(arg.skipSandboxTools).toBe(true);
    expect(arg.sandboxClient).toBeUndefined();
    expect(arg.extraTools?.meta_sandbox_list).toBeTruthy();
    expect(arg.extraTools?.meta_sandbox_switch).toBeTruthy();
  });

  it('hard forbidden resolve does NOT soft-path to meta sandbox tools (still 403)', async () => {
    mockAuthedSession();
    mockMcpEmpty();
    mockByokOk();
    mockGithubToken();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    // No selectionRequired: the user has no usable grant at all — meta sandbox
    // tools have nothing to list/switch among, so this stays a hard 403 even
    // though the tools are always present.
    servicesState.resolveSandbox = {
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json({ error: SANDBOX_FORBIDDEN_ERROR }, { status: 403 }),
      })),
    };
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent,
      runAgentStream: vi.fn(),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SANDBOX_FORBIDDEN_ERROR });
    expect(runAgent).not.toHaveBeenCalled();
  });

});
