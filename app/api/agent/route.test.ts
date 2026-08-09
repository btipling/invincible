import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_ERROR,
  SANDBOX_FORBIDDEN_ERROR,
  WORKSPACE_INSTANCE_REQUIRED_ERROR,
  BUILTIN_HTTP_INSTANCE_REQUIRED_ERROR,
} from '../../../lib/tenancy/errors';

/**
 * Route tests import the handler after env is set.
 * We mock runAgent / resolve / MCP to avoid real Gateway / DB.
 */
describe('POST /api/agent', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/agent/runAgent');
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/tenancy/resolveSandbox');
    vi.doUnmock('../../../lib/tenancy/userGithubToken');
    vi.doUnmock('../../../lib/tenancy/resolveInferenceForRequest');
    vi.doUnmock('../../../lib/mcp/client');
    vi.doUnmock('../../../lib/agent/vercelSandboxHttpRunner');
    vi.doUnmock('../../../lib/agent/httpFetchTools');
    vi.doUnmock('../../../lib/agent/builtinHttpConfig');
    vi.doUnmock('../../../lib/tenancy/userSandboxInstance');
  });

  async function loadRoute() {
    return import('./route');
  }

  function clearTenancyEnv() {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  }

  function mockByokOk(overrides: Record<string, unknown> = {}) {
    vi.doMock('../../../lib/tenancy/resolveInferenceForRequest', () => ({
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
    }));
  }

  function mockByokFail(
    reason: 'forbidden' | 'unavailable' | 'model_invalid' = 'forbidden',
  ) {
    vi.doMock('../../../lib/tenancy/resolveInferenceForRequest', () => ({
      resolveByokForRequest: vi.fn(async () => ({
        ok: false as const,
        reason,
      })),
    }));
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
    vi.doMock('../../../lib/tenancy/userSandboxInstance', () => ({
      loadInstance,
    }));
    return { loadInstance };
  }

  function mockGithubToken(value: string | null = null) {
    const decryptUserGithubTokenForServer = vi.fn(async () =>
      value
        ? { ok: true as const, value }
        : { ok: true as const, value: null },
    );
    vi.doMock('../../../lib/tenancy/userGithubToken', () => ({
      decryptUserGithubTokenForServer,
    }));
    return { decryptUserGithubTokenForServer };
  }

  it('returns 500 when gateway key missing', async () => {
    clearTenancyEnv();
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';
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

  it('returns 503 with exact sandbox-not-configured string when tenancy off', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    );
    expect(JSON.stringify(body)).not.toContain('gw-key');
  });

  it('returns 400 on bad body', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';
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

  it('200 returns text and never leaks secrets (env path)', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key-super-secret';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';

    vi.resetModules();
    const mcp = mockMcpEmpty();
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({
        text: 'hello from agent',
        toolTrace: [
          { name: 'list_dir', ok: true, summary: 'list_dir . → 0 entries' },
        ],
      })),
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
    const body = await res.json();
    expect(body.text).toBe('hello from agent');
    expect(body.toolTrace).toHaveLength(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sandbox-secret-token');
    expect(raw).not.toContain('gw-key-super-secret');
    // tenancy off → no MCP load
    expect(mcp.buildUserMcpTools).not.toHaveBeenCalled();
  });

  it('returns 499 when runAgent aborts', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'sandbox-secret-token';

    vi.resetModules();
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

  it('returns 401 with AUTH_REQUIRED_ERROR when tenancy on and unauthenticated', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    // env sandbox intentionally unset — must not mask 401 with 503
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    vi.resetModules();
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: AUTH_REQUIRED_ERROR },
          { status: 401 },
        ),
      })),
    }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'nope', toolTrace: [] })),
    }));

    const { POST } = await import('./route');
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

  it('returns 403 SANDBOX_FORBIDDEN_ERROR when resolve fails (tenancy on, no env sandbox)', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    vi.resetModules();
    const mcp = mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: SANDBOX_FORBIDDEN_ERROR },
          { status: 403 },
        ),
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
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SANDBOX_FORBIDDEN_ERROR);
    expect(runAgent).not.toHaveBeenCalled();
    // sandbox failed before MCP
    expect(mcp.buildUserMcpTools).not.toHaveBeenCalled();
  });

  it('softContinue + empty MCP + no builtin → 403 WORKSPACE_INSTANCE_REQUIRED (no runAgent)', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;

    const runAgent = vi.fn(async () => ({
      text: 'should-not-run',
      toolTrace: [],
    }));
    vi.resetModules();
    const mcp = mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        softContinue: true as const,
        response: Response.json(
          { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
          { status: 403 },
        ),
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
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: WORKSPACE_INSTANCE_REQUIRED_ERROR,
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(mcp.buildUserMcpTools).toHaveBeenCalled();
  });

  it('softContinue from resolve skips FS tools and still runs agent when MCP tools exist', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;

    type RunArg = {
      skipSandboxTools?: boolean;
      sandboxClient?: unknown;
      secrets: string[];
      prompt: string;
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'soft-ok',
      toolTrace: [],
    }));
    vi.resetModules();
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
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        softContinue: true as const,
        response: Response.json(
          { error: WORKSPACE_INSTANCE_REQUIRED_ERROR },
          { status: 403 },
        ),
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
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('soft-ok');
    expect(runAgent).toHaveBeenCalled();
    const arg = runAgent.mock.calls[0]![0] as RunArg;
    expect(arg.skipSandboxTools).toBe(true);
    expect(arg.sandboxClient).toBeUndefined();
    expect(arg.extraTools).toMatchObject({ mcp_demo_ping: expect.anything() });
    expect(buildUserMcpTools).toHaveBeenCalled();
  });


  it('tenancy on injects resolved client + BYOK without requiring env SANDBOX_*', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
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

    vi.resetModules();
    const mcp = mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
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
    expect(arg!.extraTools).toEqual({});
    expect(mcp.buildUserMcpTools).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(mcp.close).toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('sk-byok-test');
  });

  it('tenancy on merges MCP extraTools + secrets and closes clients', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
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

    vi.resetModules();
    vi.doMock('../../../lib/mcp/client', () => ({
      buildUserMcpTools: vi.fn(async () => ({
        tools: mcpTools,
        secretsToRedact: ['mcp-key-secret-value'],
        close,
        connectedSlugs: ['exa'],
        skipped: [],
      })),
    }));
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: true as const,
        value: {
          client: {
            listDir: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            exec: vi.fn(),
          },
          permissions: { canRead: true, canWrite: true },
          secrets: ['decrypted-db-token'],
          sandboxId: 'sbx-1',
          tenantId: 'ten-1',
          baseUrl: 'http://sandbox.example',
        },
      })),
    }));
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
    expect(arg!.extraTools).toEqual(mcpTools);
    expect(arg!.secrets).toContain('mcp-key-secret-value');
    expect(close).toHaveBeenCalled();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('mcp-key-secret-value');
  });

  it('tenancy on: empty BYOK grants → 403 and runAgent not called', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

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

    vi.resetModules();
    const mcp = mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokFail('forbidden');
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox,
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
    expect(body.error).toBe('Inference access denied.');
    expect(runAgent).not.toHaveBeenCalled();
    expect(resolveAgentSandbox).not.toHaveBeenCalled();
    expect(mcp.buildUserMcpTools).not.toHaveBeenCalled();
  });

  it('tenancy off, builtin on, no DO sandbox → not 503; runAgent with http tools', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    process.env.BUILTIN_HTTP_INSTANCE_NAME = 'inv-http-host';

    const close = vi.fn(async () => {});
    type HttpRunArg = {
      skipSandboxTools?: boolean;
      extraTools?: Record<string, unknown>;
      prompt: string;
    };
    const runAgent = vi.fn(async (_arg: HttpRunArg) => ({
      text: 'fetched',
      toolTrace: [{ name: 'http_get', ok: true, summary: 'http_get · ok · 200' }],
    }));

    vi.resetModules();
    mockMcpEmpty();
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close,
    }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
    }));
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
        body: JSON.stringify({ prompt: 'fetch https://example.com' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg!.skipSandboxTools).toBe(true);
    expect(arg!.extraTools?.http_get).toBeTruthy();
    expect(createRunner).toHaveBeenCalledWith({ name: 'inv-http-host' });
    expect(close).toHaveBeenCalled();
    const body = await res.json();
    expect(body.text).toBe('fetched');
  });

  it('tenancy off, builtin on, empty instance name → fail closed', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.BUILTIN_HTTP_INSTANCE_NAME;

    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    vi.resetModules();
    mockMcpEmpty();
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
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
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: BUILTIN_HTTP_INSTANCE_REQUIRED_ERROR,
    });
    expect(createRunner).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('tenancy off, builtin off, no DO → exact 503 string (host chat fallback)', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;
    const { POST } = await loadRoute();
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    );
  });

  it('tenancy on, grant deny, builtin on + running HTTP instance → not 403; http tools only', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

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
    const closeMcp = vi.fn(async () => {});

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'running', vercelName: 'inv-http-user1' });
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: 'Sandbox access denied.' },
          { status: 403 },
        ),
      })),
    }));
    vi.doMock('../../../lib/mcp/client', () => ({
      buildUserMcpTools: vi.fn(async () => ({
        tools: {},
        secretsToRedact: [] as string[],
        close: closeMcp,
        connectedSlugs: [] as string[],
        skipped: [],
      })),
    }));
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
    }));
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
    expect(closeMcp).toHaveBeenCalled();
  });

  it('tenancy on, grant deny, builtin on, no HTTP instance → hard 403 grant', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    const runAgent = vi.fn(async () => ({ text: 'nope', toolTrace: [] }));
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockHttpInstance(null);
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
      resolveAgentSandbox: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: SANDBOX_FORBIDDEN_ERROR },
          { status: 403 },
        ),
      })),
    }));
    mockMcpEmpty();
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
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
    expect(await res.json()).toEqual({ error: SANDBOX_FORBIDDEN_ERROR });
    expect(createRunner).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });


  it('tenancy on, FS ok, stopped HTTP instance → omit http tools; runAgent still runs', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    const closeHttp = vi.fn(async () => {});
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
    const sandboxClient = { close: vi.fn(async () => {}) };

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'stopped', vercelName: 'inv-http-stopped' });
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
    }));
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
    expect(runAgent).toHaveBeenCalledTimes(1);
    const arg = runAgent.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg!.sandboxClient).toBe(sandboxClient);
    expect(arg!.extraTools?.http_get).toBeUndefined();
    expect(createRunner).not.toHaveBeenCalled();
    expect(closeHttp).not.toHaveBeenCalled();
  });

  it('tenancy on, FS ok, error HTTP status → omit http tools; runAgent still runs', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

    type RunArg = {
      sandboxClient?: unknown;
      extraTools?: Record<string, unknown>;
    };
    const runAgent = vi.fn(async (_arg: RunArg) => ({
      text: 'fs only',
      toolTrace: [],
    }));
    const sandboxClient = { close: vi.fn(async () => {}) };

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'error', vercelName: 'inv-http-err' });
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
    const createRunner = vi.fn(() => ({ get: vi.fn(), close: vi.fn() }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
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
    expect(arg!.extraTools?.http_get).toBeUndefined();
    expect(createRunner).not.toHaveBeenCalled();
  });

  it('tenancy on, FS ok, running HTTP instance → http tools + FS; attach name from instance', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;

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

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    mockHttpInstance({ status: 'running', vercelName: '  inv-http-both  ' });
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
    const createRunner = vi.fn(() => ({
      get: vi.fn(),
      close: closeHttp,
    }));
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: createRunner,
    }));
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
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';
    process.env.BUILTIN_HTTP_FETCH = 'sandbox';
    process.env.BUILTIN_HTTP_INSTANCE_NAME = 'inv-http-host';

    const closeHttp = vi.fn(async () => {});
    vi.resetModules();
    mockMcpEmpty();
    vi.doMock('../../../lib/agent/vercelSandboxHttpRunner', () => ({
      createVercelSandboxHttpRunner: vi.fn(() => ({
        get: vi.fn(),
        close: closeHttp,
      })),
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


  it('returns 400 for host-absolute cwd', async () => {
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: null,
      })),
    }));
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
    clearTenancyEnv();
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.SANDBOX_URL = 'http://127.0.0.1:8787';
    process.env.SANDBOX_TOKEN = 'tok';

    const runAgent = vi.fn(async (arg: { initialCwd?: string }) => ({
      text: 'ok',
      toolTrace: [],
      cwd: arg.initialCwd ?? '.',
    }));

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: null,
      })),
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


  it('JSON finally closes vercel sandbox client close()', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;

    const closeSandbox = vi.fn(async () => {});
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: closeSandbox,
    };
    const runAgent = vi.fn(async () => ({ text: 'ok', toolTrace: [] }));

    vi.resetModules();
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    expect(closeSandbox).toHaveBeenCalledTimes(1);
  });

  it('stream start finally closes sandbox client', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;

    const closeSandbox = vi.fn(async () => {});
    const fakeClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
      close: closeSandbox,
    };

    vi.resetModules();
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
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
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    delete process.env.BUILTIN_HTTP_FETCH;

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

    vi.resetModules();
    mockMcpEmpty();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    mockByokOk();
    mockGithubToken();
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({
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
    }));
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



  it('tenancy on injects GitHub PAT into resolveAgentSandbox execEnv and secrets', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
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

    vi.resetModules();
    mockByokOk();
    mockMcpEmpty();
    mockGithubToken('ghp_pat_secret_value');
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1' },
      })),
    }));
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({ resolveAgentSandbox }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async (arg: { secrets?: string[] }) => ({
        text: 'ok',
        toolTrace: [],
      })),
      runAgentStream: vi.fn(),
    }));
    vi.doMock('../../../lib/agent/builtinHttpConfig', () => ({
      resolveBuiltinHttpConfig: () => ({ enabled: false }),
    }));

    const { POST } = await loadRoute();
    const { runAgent } = await import('../../../lib/agent/runAgent');
    const res = await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(resolveAgentSandbox).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        execEnv: {
          GH_TOKEN: 'ghp_pat_secret_value',
          GITHUB_TOKEN: 'ghp_pat_secret_value',
        },
      }),
    );
    const arg = vi.mocked(runAgent).mock.calls[0]?.[0] as { secrets?: string[] };
    expect(arg.secrets).toContain('ghp_pat_secret_value');
    expect(arg.secrets).toContain('decrypted-db-token');
  });

  it('tenancy on omits execEnv when GitHub token unset', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
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

    vi.resetModules();
    mockByokOk();
    mockMcpEmpty();
    mockGithubToken(null);
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1' },
      })),
    }));
    vi.doMock('../../../lib/tenancy/resolveSandbox', () => ({ resolveAgentSandbox }));
    vi.doMock('../../../lib/agent/runAgent', () => ({
      runAgent: vi.fn(async () => ({ text: 'ok', toolTrace: [] })),
      runAgentStream: vi.fn(),
    }));
    vi.doMock('../../../lib/agent/builtinHttpConfig', () => ({
      resolveBuiltinHttpConfig: () => ({ enabled: false }),
    }));

    const { POST } = await loadRoute();
    await POST(
      new Request('http://localhost/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(resolveAgentSandbox).toHaveBeenCalledWith('user-1', {});
  });

});
