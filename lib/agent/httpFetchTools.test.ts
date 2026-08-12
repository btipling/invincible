import { describe, expect, it, vi } from 'vitest';
import {
  createHttpFetchTools,
  fetchFollowingRedirects,
  isHttpRedirectStatus,
  isTextishContentType,
  resolveRedirectLocation,
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

describe('isHttpRedirectStatus / resolveRedirectLocation', () => {
  it('treats 301/302/303/307/308 as redirects, not 304', () => {
    expect(isHttpRedirectStatus(301)).toBe(true);
    expect(isHttpRedirectStatus(302)).toBe(true);
    expect(isHttpRedirectStatus(304)).toBe(false);
    expect(isHttpRedirectStatus(200)).toBe(false);
  });

  it('resolves relative Location against base', () => {
    expect(resolveRedirectLocation('/b', 'https://example.com/a')).toBe(
      'https://example.com/b',
    );
    expect(resolveRedirectLocation('https://other.test/x', 'https://example.com/a')).toBe(
      'https://other.test/x',
    );
    expect(resolveRedirectLocation('', 'https://example.com/a')).toBeNull();
  });
});

describe('fetchFollowingRedirects', () => {
  it('follows one safe redirect and ignores intermediate body', async () => {
    const get = vi.fn(async (input: { url: string }) => {
      if (input.url === 'https://example.com/start') {
        return {
          status: 302,
          contentType: 'text/html',
          body: 'secret-redirect-body',
          location: 'https://example.com/final',
        };
      }
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'final-body',
      };
    });
    const out = await fetchFollowingRedirects({
      runner: fakeRunner(get),
      url: 'https://example.com/start',
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.finalUrl).toBe('https://example.com/final');
    expect(out.redirects).toBe(1);
    expect(out.result.body).toBe('final-body');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('blocks redirect to private host without second hop', async () => {
    const get = vi.fn(async () => ({
      status: 302,
      contentType: 'text/html',
      body: 'nope',
      location: 'https://127.0.0.1/secret',
    }));
    const out = await fetchFollowingRedirects({
      runner: fakeRunner(get),
      url: 'https://example.com/r',
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/redirect blocked/i);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('errors when redirect lacks Location', async () => {
    const get = vi.fn(async () => ({
      status: 302,
      contentType: 'text/html',
      body: 'secret-redirect-body',
    }));
    const out = await fetchFollowingRedirects({
      runner: fakeRunner(get),
      url: 'https://example.com/r',
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/missing Location/i);
  });

  it('caps redirect chain', async () => {
    const get = vi.fn(async (input: { url: string }) => {
      const n = Number(new URL(input.url).pathname.replace('/', '') || '0');
      return {
        status: 302,
        contentType: 'text/html',
        body: '',
        location: `https://example.com/${n + 1}`,
      };
    });
    const out = await fetchFollowingRedirects({
      runner: fakeRunner(get),
      url: 'https://example.com/0',
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 2,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/too many redirects/i);
    // start + 2 follows = 3 gets, then refuse next
    expect(get.mock.calls.length).toBeLessThanOrEqual(3);
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

  it('follows public redirect and does not expose intermediate body', async () => {
    const get = vi.fn(async (input: { url: string }) => {
      if (input.url.includes('/r')) {
        return {
          status: 302,
          contentType: 'text/html',
          body: 'secret-redirect-body',
          location: 'https://example.com/ok',
        };
      }
      return {
        status: 200,
        contentType: 'text/plain',
        body: 'landed',
      };
    });
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/r' },
      execOpts,
    )) as string;
    expect(out).toContain('landed');
    expect(out).toMatch(/via 1 redirect/);
    expect(out).not.toContain('secret-redirect-body');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('soft-fails redirect to private without dumping bodies', async () => {
    const get = vi.fn(async () => ({
      status: 302,
      contentType: 'text/html',
      body: 'secret-redirect-body',
      location: 'https://169.254.169.254/latest/meta-data/',
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
    expect(out).toMatch(/ERROR http_get:.*redirect blocked/i);
    expect(out).not.toContain('secret-redirect-body');
  });

  it('soft-fails 3xx without Location without trusting body', async () => {
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
    expect(out).toMatch(/ERROR http_get:.*Location/i);
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

  it('http_head follows safe redirects', async () => {
    const get = vi.fn(async (input: { url: string; head?: boolean }) => {
      expect(input.head).toBe(true);
      if (input.url.endsWith('/start')) {
        return {
          status: 301,
          contentType: 'text/html',
          body: '',
          location: 'https://example.com/end',
        };
      }
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
      { url: 'https://example.com/start' },
      execOpts,
    )) as string;
    expect(out).toContain('https://example.com/end');
    expect(out).toMatch(/via 1 redirect/);
    expect(get).toHaveBeenCalledTimes(2);
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

  it('redacts root-resolved AI_GATEWAY_API_KEY from soft-fail errors via serverSecrets', async () => {
    const get = vi.fn(async () => {
      throw new Error('upstream failed gateway-secret-should-not-leak');
    });
    const tools = createHttpFetchTools({
      runner: fakeRunner(get),
      maxBytes: 1024,
      timeoutMs: 5000,
      serverSecrets: { gatewayKey: 'gateway-secret-should-not-leak' },
    });
    const out = (await tools.http_get.execute!(
      { url: 'https://example.com/' },
      execOpts,
    )) as string;
    expect(out).toMatch(/^ERROR http_get:/);
    expect(out).not.toContain('gateway-secret-should-not-leak');
    expect(out).toContain('[redacted]');
  });
});
