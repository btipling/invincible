import { describe, expect, it, vi } from 'vitest';
import {
  createHttpFetchTools,
  isTextishContentType,
} from './httpFetchTools';
import type { HttpFetchRunner } from './httpFetchTypes';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';

function fakeRunner(
  impl: HttpFetchRunner['get'],
): HttpFetchRunner & { close: ReturnType<typeof vi.fn> } {
  return {
    get: impl,
    close: vi.fn(async () => {}),
  };
}

const execOpts = { toolCallId: '1', messages: [] } as never;

describe('isTextishContentType', () => {
  it('accepts text, json, xml, +json', () => {
    expect(isTextishContentType('text/html; charset=utf-8')).toBe(true);
    expect(isTextishContentType('application/json')).toBe(true);
    expect(isTextishContentType('application/ld+json')).toBe(true);
    expect(isTextishContentType('application/xml')).toBe(true);
    expect(isTextishContentType('image/png')).toBe(false);
    expect(isTextishContentType(undefined)).toBe(false);
  });
});

describe('createHttpFetchTools', () => {
  it('rejects non-https via policy without calling runner', async () => {
    const get = vi.fn();
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'http://example.com' },
      execOpts,
    )) as string;
    expect(out).toMatch(/^ERROR http_get:/);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects private hosts without calling runner', async () => {
    const get = vi.fn();
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://127.0.0.1/' },
      execOpts,
    )) as string;
    expect(out).toMatch(/ERROR http_get:/);
    expect(get).not.toHaveBeenCalled();
  });

  it('calls runner once on policy OK and returns body', async () => {
    const get = vi.fn(async () => ({
      status: 200,
      contentType: 'text/plain',
      body: 'hello world',
    }));
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/a' },
      execOpts,
    )) as string;
    expect(get).toHaveBeenCalledTimes(1);
    expect(out).toContain('hello world');
    expect(out).toContain('200');
  });

  it('soft-fails 3xx without trusting body', async () => {
    const get = vi.fn(async () => ({
      status: 302,
      contentType: 'text/html',
      body: 'secret-redirect-body',
    }));
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/r' },
      execOpts,
    )) as string;
    expect(out).toMatch(/ERROR http_get:.*redirect/i);
    expect(out).not.toContain('secret-redirect-body');
  });

  it('rejects non-text content-type without dumping body', async () => {
    const get = vi.fn(async () => ({
      status: 200,
      contentType: 'application/octet-stream',
      body: 'BINARY_BLOB_SHOULD_NOT_APPEAR',
    }));
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/bin' },
      execOpts,
    )) as string;
    expect(out).toMatch(/ERROR http_get:.*content-type/i);
    expect(out).not.toContain('BINARY_BLOB');
  });

  it('truncates oversized model-facing text and redacts secrets', async () => {
    const secret = 'super-secret-token-xyz';
    // Put secret near the start so redaction is visible before char cap.
    const big = `prefix ${secret} ` + 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
    const get = vi.fn(async () => ({
      status: 200,
      contentType: 'text/plain',
      body: big,
      truncated: true,
    }));
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 100_000,
      timeoutMs: 5000,
      secrets: [secret],
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/big' },
      execOpts,
    )) as string;
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 20);
    expect(out).toContain('[truncated]');
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('soft-fails when runner throws', async () => {
    const get = vi.fn(async () => {
      throw new Error('create failed secret-token-value');
    });
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
      secrets: ['secret-token-value'],
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/' },
      execOpts,
    )) as string;
    expect(out).toMatch(/^ERROR http_get:/);
    expect(out).not.toContain('secret-token-value');
  });

  it('http_head returns status line', async () => {
    const get = vi.fn(async (input) => {
      expect(input.head).toBe(true);
      return {
        status: 200,
        contentType: 'text/html',
        body: '',
      };
    });
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_head!.execute!(
      { url: 'https://example.com/' },
      execOpts,
    )) as string;
    expect(out).toMatch(/http_head/);
    expect(out).toContain('200');
  });

  it('propagates abort via runner error soft-fail', async () => {
    const get = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/' },
      execOpts,
    )) as string;
    expect(out).toMatch(/^ERROR http_get:/);
  });

  it('redacts AI_GATEWAY_API_KEY from soft-fail errors even without opts.secrets', async () => {
    const prev = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = 'gateway-secret-should-not-leak';
    try {
      const get = vi.fn(async () => {
        throw new Error('upstream failed gateway-secret-should-not-leak');
      });
      const tools = createHttpFetchTools({
        runner: fakeRunner(get),
        maxBytes: 1024,
        timeoutMs: 5000,
      });
      const out = (await tools.http_get.execute!(
        { url: 'https://example.com/' },
        execOpts,
      )) as string;
      expect(out).toMatch(/^ERROR http_get:/);
      expect(out).not.toContain('gateway-secret-should-not-leak');
      expect(out).toContain('[redacted]');
    } finally {
      if (prev == null) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = prev;
    }
  });
});
