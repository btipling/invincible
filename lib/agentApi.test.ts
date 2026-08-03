import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_NOT_CONFIGURED_ERROR, sendAgent } from './agentApi';
import { AUTH_REQUIRED_ERROR } from './tenancy/errors';

describe('sendAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses success with toolTrace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          text: 'done',
          toolTrace: [{ name: 'list_dir', ok: true, summary: 'list_dir . → 0' }],
        }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result).toEqual({
      ok: true,
      text: 'done',
      toolTrace: [{ name: 'list_dir', ok: true, summary: 'list_dir . → 0' }],
    });
  });

  it('marks sandboxNotConfigured only on 503 + exact string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: SANDBOX_NOT_CONFIGURED_ERROR },
          { status: 503 },
        ),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sandboxNotConfigured).toBe(true);
      expect(result.status).toBe(503);
      expect(result.error).toBe(SANDBOX_NOT_CONFIGURED_ERROR);
    }
  });

  it('does not mark sandboxNotConfigured on 503 with other body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'Upstream overloaded' }, { status: 503 }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sandboxNotConfigured).toBeUndefined();
      expect(result.error).toBe('Upstream overloaded');
    }
  });

  it('returns cancelled on abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new DOMException('Aborted', 'AbortError');
        throw err;
      }),
    );
    const result = await sendAgent('hi');
    expect(result).toEqual({ ok: false, error: 'Request cancelled.' });
  });

  it('does not mark sandboxNotConfigured on 401 auth required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
      ),
    );
    const result = await sendAgent('hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe(AUTH_REQUIRED_ERROR);
      expect(result.sandboxNotConfigured).toBeUndefined();
    }
  });

});
