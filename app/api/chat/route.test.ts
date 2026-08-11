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

  it('passes through to gateway gate', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true,
        user: { id: 'user-1', email: 'a@b.c' },
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
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/AI_GATEWAY_API_KEY/);
  });

  it('returns 401 with AUTH_REQUIRED_ERROR when unauthenticated', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
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

  it('authed without user id → 401', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    vi.resetModules();
    vi.doMock('../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true as const,
        user: null,
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

  it('attaches BYOK providerOptions to generateText', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
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

  it('no grant → 403 and generateText not called', async () => {
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
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
});
