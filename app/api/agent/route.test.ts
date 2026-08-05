import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_ERROR,
  SANDBOX_FORBIDDEN_ERROR,
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
    vi.doUnmock('../../../lib/tenancy/resolveInferenceForRequest');
    vi.doUnmock('../../../lib/mcp/client');
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
    expect(arg!.extraTools).toBe(mcpTools);
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
});
