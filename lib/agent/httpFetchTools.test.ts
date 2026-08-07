import { describe, expect, it, vi } from 'vitest';
import { createHttpFetchTools } from './httpFetchTools';
import type { HttpFetchRunner } from './httpFetchTypes';

function mockRunner(
  overrides: Partial<HttpFetchRunner> = {},
): HttpFetchRunner {
  return {
    get: vi.fn(async () => ({
      status: 200,
      contentType: 'text/plain',
      body: 'hello',
    })),
    head: vi.fn(async () => ({
      status: 200,
      contentType: 'text/html',
      contentLength: '42',
    })),
    ...overrides,
  };
}

describe('createHttpFetchTools', () => {
  it('rejects non-https via policy', async () => {
    const runner = mockRunner();
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!({ url: 'http://example.com' }, {
      toolCallId: 't1',
      messages: [],
    });
    expect(String(out)).toMatch(/ERROR http_get:.*https/i);
    expect(runner.get).not.toHaveBeenCalled();
  });

  it('rejects private host', async () => {
    const runner = mockRunner();
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!({ url: 'https://127.0.0.1/' }, {
      toolCallId: 't1',
      messages: [],
    });
    expect(String(out)).toMatch(/ERROR http_get/);
    expect(runner.get).not.toHaveBeenCalled();
  });

  it('calls runner once on policy OK', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => ({
        status: 200,
        contentType: 'text/plain',
        body: 'ok body',
      })),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/doc' },
      { toolCallId: 't1', messages: [] },
    );
    expect(runner.get).toHaveBeenCalledTimes(1);
    expect(String(out)).toMatch(/http_get https:\/\/example.com\/doc status=200/);
    expect(String(out)).toContain('ok body');
  });

  it('soft-fails when runner throws', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => {
        throw new Error('sandbox create failed');
      }),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toMatch(/ERROR http_get: sandbox create failed/);
  });

  it('rejects non-text content-type with body', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => ({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'bin',
      })),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/bin' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toMatch(/ERROR http_get: non-text content-type/);
  });

  it('accepts application/json', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => ({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: '{"a":1}',
      })),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/api' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toContain('{"a":1}');
  });

  it('surfaces redirect status as error', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => ({
        status: 302,
        contentType: 'text/html',
        body: '',
      })),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/redir' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toMatch(/redirect status 302/);
  });

  it('marks truncated body', async () => {
    const runner = mockRunner({
      get: vi.fn(async () => ({
        status: 200,
        contentType: 'text/plain',
        body: 'partial',
        truncated: true,
      })),
    });
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/big' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toMatch(/\(truncated\)/);
  });

  it('registers http_head when runner.head present', async () => {
    const runner = mockRunner();
    const tools = createHttpFetchTools({ runner });
    expect(tools).toHaveProperty('http_head');
    const out = await tools.http_head!.execute!(
      { url: 'https://example.com/' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).toMatch(/http_head https:\/\/example.com\/ status=200/);
    expect(String(out)).toMatch(/content-type=text\/html/);
  });

  it('omits http_head when runner has no head', async () => {
    const runner: HttpFetchRunner = {
      get: vi.fn(async () => ({
        status: 200,
        contentType: 'text/plain',
        body: 'x',
      })),
    };
    const tools = createHttpFetchTools({ runner });
    expect(tools).not.toHaveProperty('http_head');
  });

  it('redacts secrets in errors', async () => {
    const secret = 'super-secret-token-xyz';
    const runner = mockRunner({
      get: vi.fn(async () => {
        throw new Error(`failed with ${secret}`);
      }),
    });
    const tools = createHttpFetchTools({ runner, secrets: [secret] });
    const out = await tools.http_get.execute!(
      { url: 'https://example.com/' },
      { toolCallId: 't1', messages: [] },
    );
    expect(String(out)).not.toContain(secret);
    expect(String(out)).toContain('[redacted]');
  });

  it('requires url', async () => {
    const runner = mockRunner();
    const tools = createHttpFetchTools({ runner });
    const out = await tools.http_get.execute!({ url: '' }, {
      toolCallId: 't1',
      messages: [],
    });
    expect(String(out)).toMatch(/url is required/);
  });
});
