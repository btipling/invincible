import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_ERROR,
  INFERENCE_FORBIDDEN_ERROR,
} from '../../../lib/tenancy/errors';

describe('POST /api/chat', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.doUnmock('../../../lib/tenancy/session');
    vi.doUnmock('../../../lib/tenancy/resolveInferenceForRequest');
    vi.doUnmock('ai');
  });

  // Phase 1 made requireSessionUser always fail-closed and import next-auth.
  // The tenancy-off route branch stays until Phase 2, so mock the old open result.
  function mockTenancyOffSession() {
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: null,
      })),
    }));
  }

  it('passes through to gateway gate when tenancy off', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    vi.resetModules();
    mockTenancyOffSession();

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/AI_GATEWAY_API_KEY/);
  });

  it('returns 401 with AUTH_REQUIRED_ERROR when tenancy on and unauthenticated', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false as const,
        response: Response.json(
          { error: AUTH_REQUIRED_ERROR },
          { status: 401 },
        ),
      })),
    }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(AUTH_REQUIRED_ERROR);
  });

  it('tenancy on: attaches BYOK providerOptions to generateText', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

    const generateText = vi.fn(async (_args: unknown) => ({ text: 'byok-hello' }));

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    vi.doMock('../../../lib/tenancy/resolveInferenceForRequest', () => ({
      resolveByokForRequest: vi.fn(async () => ({
        ok: true as const,
        modelId: 'anthropic/claude-a',
        provider: 'anthropic',
        credentials: { apiKey: 'sk-chat-byok' },
        only: ['anthropic'] as [string],
        byok: { anthropic: [{ apiKey: 'sk-chat-byok' }] },
        secretId: 'sec-1',
        secretsToRedact: ['sk-chat-byok'],
      })),
    }));
    vi.doMock('ai', () => ({ generateText }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi there' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('byok-hello');
    expect(generateText).toHaveBeenCalledTimes(1);
    const arg = (generateText.mock.calls as unknown as unknown[][])[0]?.[0] as {
      model: string;
      prompt: string;
      providerOptions: {
        gateway: { only: unknown; byok: unknown };
      };
    };
    expect(arg).toBeDefined();
    expect(arg.model).toBe('anthropic/claude-a');
    expect(arg.prompt).toBe('hi there');
    expect(arg.providerOptions.gateway.only).toEqual(['anthropic']);
    expect(arg.providerOptions.gateway.byok).toEqual({
      anthropic: [{ apiKey: 'sk-chat-byok' }],
    });
    expect(JSON.stringify(body)).not.toContain('sk-chat-byok');
  });

  it('tenancy on: no grant → 403 and generateText not called', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DATABASE_URL = 'postgres://localhost/db';
    process.env.AUTH_SECRET = 'test-auth-secret-at-least-32-chars!!';
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

    const generateText = vi.fn(async (_args: unknown) => ({ text: 'nope' }));

    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: { id: 'user-1', email: 'a@b.c' },
      })),
    }));
    vi.doMock('../../../lib/tenancy/resolveInferenceForRequest', () => ({
      resolveByokForRequest: vi.fn(async () => ({
        ok: false as const,
        reason: 'forbidden' as const,
      })),
    }));
    vi.doMock('ai', () => ({ generateText }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(INFERENCE_FORBIDDEN_ERROR);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('tenancy off: uses env model path without BYOK', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.DEFAULT_MODEL = 'openai/gpt-test';

    const generateText = vi.fn(async (_args: unknown) => ({ text: 'env-hello' }));

    vi.resetModules();
    mockTenancyOffSession();
    vi.doMock('ai', () => ({ generateText }));

    const { POST } = await import('./route');
    const res = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe('env-hello');
    expect(generateText).toHaveBeenCalledTimes(1);
    const arg = (generateText.mock.calls as unknown as unknown[][])[0]?.[0] as {
      model: string;
      providerOptions?: unknown;
    };
    expect(arg).toBeDefined();
    expect(arg.model).toBe('openai/gpt-test');
    expect(arg.providerOptions).toBeUndefined();
  });
});
