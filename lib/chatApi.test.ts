import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_MODEL_LABEL,
  normalizePrompt,
  sendChat,
  validatePrompt,
} from './chatApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validatePrompt', () => {
  it('rejects empty / whitespace', () => {
    expect(validatePrompt('')).toBe('Enter a prompt.');
    expect(validatePrompt('   \n\t')).toBe('Enter a prompt.');
  });

  it('accepts non-empty prompt', () => {
    expect(validatePrompt('hello')).toBeNull();
  });

  it('rejects overlong prompts', () => {
    expect(validatePrompt('x'.repeat(32_001))).toMatch(/too long/i);
  });
});

describe('normalizePrompt', () => {
  it('trims ends', () => {
    expect(normalizePrompt('  hi  ')).toBe('hi');
  });
});

describe('DEFAULT_MODEL_LABEL', () => {
  it('is a provider/model string', () => {
    expect(DEFAULT_MODEL_LABEL).toContain('/');
  });
});

describe('sendChat', () => {
  it('posts JSON and returns text on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'pong' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendChat('  ping  ');
    expect(result).toEqual({ ok: true, text: 'pong' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prompt: 'ping' }),
      }),
    );
  });

  it('maps 404 to phase-1.4 hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
    const result = await sendChat('x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toMatch(/1\.4/i);
    }
  });

  it('surfaces JSON error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'no key' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await sendChat('x');
    expect(result).toEqual({ ok: false, status: 500, error: 'no key' });
  });

  it('includes modelId when provided', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await sendChat('hi', { modelId: 'anthropic/claude-a' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        body: JSON.stringify({ prompt: 'hi', modelId: 'anthropic/claude-a' }),
      }),
    );
  });
});
