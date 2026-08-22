import { describe, expect, it, vi, afterEach } from 'vitest';
import { WorkPathError } from '../agent/workPath';
import { SandboxHttpError } from './types';
import {
  classifyVercelError,
  withTransientRetry,
  statusFromClassified,
  EXTEND_THROTTLE_MS,
} from './resilience';

/** Duck-typed @vercel/sandbox APIError (`response.status` + `json.error.code`). */
function apiError(status: number, opts: { code?: string; message?: string } = {}) {
  const err = new Error(opts.message ?? `sdk ${status}`);
  (err as unknown as { response: unknown }).response = { status };
  (err as unknown as { json: unknown }).json = {
    error: { code: opts.code ?? null },
  };
  return err;
}

function streamError(code: string): Error {
  // Match @vercel/sandbox StreamError identity (name + code + sessionId).
  return Object.assign(new Error(code), {
    name: 'StreamError',
    code,
    sessionId: 'test-session',
  }) as Error;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyVercelError', () => {
  it('image_not_ready / preparing → retryable', () => {
    expect(classifyVercelError(apiError(400, { code: 'image_not_ready' }))).toMatchObject(
      { kind: 'retryable' },
    );
    expect(classifyVercelError(apiError(409, { code: 'preparing' }))).toMatchObject({
      kind: 'retryable',
    });
    expect(classifyVercelError(apiError(422, { code: 'sandbox_not_ready' }))).toMatchObject({
      kind: 'retryable',
    });
    expect(classifyVercelError(streamError('image_not_ready'))).toMatchObject({
      kind: 'retryable',
    });
  });

  it('408 / 429 / 5xx → retryable', () => {
    expect(classifyVercelError(apiError(408))).toMatchObject({ kind: 'retryable' });
    expect(classifyVercelError(apiError(429))).toMatchObject({ kind: 'retryable' });
    expect(classifyVercelError(apiError(503))).toMatchObject({ kind: 'retryable' });
  });

  it('Unoptimized / invalid image config → permanent 400, distinct from transient', () => {
    expect(classifyVercelError(new Error('image is unoptimized'))).toEqual({
      kind: 'permanent',
      status: 400,
    });
    expect(classifyVercelError(apiError(400, { message: 'unknown image xyz' }))).toEqual({
      kind: 'permanent',
      status: 400,
    });
  });

  it('WorkPathError → permanent 400, zero retry', () => {
    expect(classifyVercelError(new WorkPathError('escapes root'))).toEqual({
      kind: 'permanent',
      status: 400,
    });
  });

  it('SDK-owned 410 / 422 stopping|snapshotting → pass_through (no app retry)', () => {
    expect(classifyVercelError(apiError(410))).toEqual({
      kind: 'pass_through',
      status: 410,
    });
    expect(
      classifyVercelError(apiError(422, { code: 'sandbox_stopping' })),
    ).toEqual({ kind: 'pass_through', status: 422, code: 'sandbox_stopping' });
    expect(
      classifyVercelError(apiError(422, { code: 'sandbox_snapshotting' })),
    ).toEqual({
      kind: 'pass_through',
      status: 422,
      code: 'sandbox_snapshotting',
    });
  });

  it('403 / 404 / 413 → permanent, no retry', () => {
    expect(classifyVercelError(apiError(403))).toEqual({ kind: 'permanent', status: 403 });
    expect(classifyVercelError(apiError(404))).toEqual({ kind: 'permanent', status: 404 });
    expect(classifyVercelError(apiError(413))).toEqual({ kind: 'permanent', status: 413 });
    expect(classifyVercelError(new Error('ENOENT: /vercel/workspace/x'))).toEqual({
      kind: 'permanent',
      status: 404,
    });
  });

  it('AbortError / abort → permanent 504, never sleeps', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(classifyVercelError(e)).toEqual({ kind: 'permanent', status: 504 });
    expect(statusFromClassified(e)).toBe(504);
  });

  it('unknown → fails closed (permanent, no retry)', () => {
    expect(classifyVercelError(new Error('weird platform text'))).toEqual({
      kind: 'permanent',
      status: undefined,
    });
  });

  it('bare "not found" without image prefix stays 404, not retryable', () => {
    expect(classifyVercelError(new Error('resource not found'))).toEqual({
      kind: 'permanent',
      status: 404,
    });
  });

  it('message "image is not ready" (no machine code) is retryable, not permanent', () => {
    // Regression: permanent phrase must NOT be a prefix of the readiness message.
    expect(classifyVercelError(new Error('image is not ready'))).toEqual({
      kind: 'retryable',
    });
    expect(classifyVercelError(new Error('Image is not ready for use'))).toEqual({
      kind: 'retryable',
    });
    // APIError 400 with message only (code absent) must also retry.
    expect(
      classifyVercelError(apiError(400, { message: 'image is not ready' })),
    ).toMatchObject({ kind: 'retryable', status: 400 });
    // Distinct permanent config still permanent.
    expect(classifyVercelError(new Error('image is not valid'))).toEqual({
      kind: 'permanent',
      status: 400,
    });
  });

  it('Node system errors with .code (ENOENT) stay 404 — not StreamError 502', () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    expect(classifyVercelError(enoent)).toEqual({
      kind: 'permanent',
      status: 404,
    });
    expect(statusFromClassified(enoent)).toBe(404);

    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    // No message match for 403/404 — fail-closed permanent without inventing StreamError.
    expect(classifyVercelError(eacces).kind).toBe('permanent');
    expect(classifyVercelError(eacces)).not.toHaveProperty('code');
  });

  it('StreamError is only recognized by name/sessionId, not bare .code', () => {
    const stream = streamError('sandbox_booting');
    expect(classifyVercelError(stream)).toMatchObject({
      kind: 'retryable',
      code: 'sandbox_booting',
    });
    const permanentStream = streamError('other_code');
    expect(classifyVercelError(permanentStream)).toMatchObject({
      kind: 'permanent',
      code: 'other_code',
    });
  });

  it('SandboxHttpError passes through its authored status', () => {
    expect(classifyVercelError(new SandboxHttpError('matched 2 times', 409))).toEqual({
      kind: 'permanent',
      status: 409,
    });
  });
});

describe('statusFromClassified', () => {
  it('surfaced retryable → 502 (platform not ready after budget)', () => {
    expect(statusFromClassified(apiError(400, { code: 'image_not_ready' }))).toBe(502);
  });
  it('surfaced pass_through → 502', () => {
    expect(statusFromClassified(apiError(410))).toBe(502);
  });
  it('permanent keeps its own status; unknown falls back', () => {
    expect(statusFromClassified(apiError(403))).toBe(403);
    expect(statusFromClassified(new Error('weird'))).toBe(502);
  });
});

describe('withTransientRetry', () => {
  it('retries transients then succeeds; budget respected', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw apiError(503);
      return 'ok';
    });
    await expect(
      withTransientRetry(fn, { baseMs: 5, capMs: 50, jitterMs: 0 }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('permanent error → fn called once, no backoff sleep', async () => {
    const fn = vi.fn(async () => {
      throw new SandboxHttpError('bad path', 403);
    });
    await expect(
      withTransientRetry(fn, { baseMs: 5, capMs: 50, jitterMs: 0 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('SDK-owned pass_through → fn called once, no app retry', async () => {
    const fn = vi.fn(async () => {
      throw apiError(410);
    });
    await expect(
      withTransientRetry(fn, { baseMs: 5, capMs: 50, jitterMs: 0 }),
    ).rejects.toMatchObject({});
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retryable budget then calls onExhaustedRetryable', async () => {
    const onExhausted = vi.fn();
    const fn = vi.fn(async () => {
      throw apiError(503);
    });
    await expect(
      withTransientRetry(fn, {
        retries: 2,
        baseMs: 1,
        capMs: 5,
        jitterMs: 0,
        onExhaustedRetryable: onExhausted,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('aborts during backoff immediately (no further attempts)', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw apiError(503);
    });
    const p = withTransientRetry(fn, {
      retries: 4,
      baseMs: 10_000,
      capMs: 10_000,
      jitterMs: 0,
      signal: ac.signal,
    });
    await vi.advanceTimersByTimeAsync(0); // finish attempt 0, enter first backoff
    expect(calls).toBe(1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('plan #759 test 11 — NO `classify` still uses classifyVercelError (sandbox back-compat)', async () => {
    // The additive classifier seam must NOT change sandbox behavior: with no
    // `classify`, a 503 APIError is still retryable (classifyVercelError's rule).
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw apiError(503);
      return 'ok';
    });
    await expect(
      withTransientRetry(fn, { baseMs: 2, capMs: 10, jitterMs: 0 }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3); // retried via classifyVercelError default
  });

  it('plan #759 test 11 — passing a `classify` override uses it (not classifyVercelError)', async () => {
    // A domain caller injects its own classifier; the sandbox default must be
    // bypassed entirely — here a 503 is declared permanent (0 retries) by the
    // narrow injectable predicate, proving the seam route was taken.
    const classify = vi.fn(() => ({ kind: 'permanent' as const, status: 503 }));
    const fn = vi.fn(async () => {
      throw apiError(503);
    });
    await expect(
      withTransientRetry(fn, { baseMs: 2, capMs: 10, jitterMs: 0, classify }),
    ).rejects.toMatchObject({});
    expect(classify).toHaveBeenCalledTimes(1); // only the first attempt classified
    expect(fn).toHaveBeenCalledTimes(1); // permanent → no retry
  });
});

describe('EXTEND_THROTTLE_MS constant', () => {
  it('is a named, sane default (5 min) below the 30m idle family', () => {
    expect(EXTEND_THROTTLE_MS).toBe(300_000);
  });
});
