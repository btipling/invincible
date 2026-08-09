import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VercelSandboxHttpRunner,
  parseCurlHeaders,
  commandOutput,
  DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS,
  type GetSandboxFn,
  type SandboxLike,
  type SandboxCommandResult,
} from './vercelSandboxHttpRunner';
import { USER_SANDBOX_IDLE_TIMEOUT_MS } from '../tenancy/userSandboxInstance';

function mockSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
  return {
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout:
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n',
      stderr: '',
    })),
    stop: vi.fn(async () => ({})),
    extendTimeout: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('parseCurlHeaders', () => {
  it('parses status and content-type', () => {
    const r = parseCurlHeaders(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n',
    );
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
  });

  it('parses Location for redirect responses', () => {
    const r = parseCurlHeaders(
      'HTTP/1.1 302 Found\r\nLocation: https://example.com/next\r\nContent-Type: text/html\r\n\r\n',
    );
    expect(r.status).toBe(302);
    expect(r.location).toBe('https://example.com/next');
    expect(r.contentType).toMatch(/text\/html/);
  });
});


/** Mimics @vercel/sandbox CommandFinished: stdout/stderr are methods using `this`. */
function sdkStyleCommandResult(headers: string, body = ''): SandboxCommandResult {
  const cache = {
    stdout: headers,
    stderr: '',
    both: headers + body,
  };
  return {
    exitCode: 0,
    async output(stream: 'stdout' | 'stderr' | 'both' = 'both') {
      return cache[stream];
    },
    async stdout() {
      return this.output!('stdout');
    },
    async stderr() {
      return this.output!('stderr');
    },
  };
}

describe('commandOutput this-binding (SDK CommandFinished)', () => {
  it('reads stdout via methods without detaching this', async () => {
    const cmd = sdkStyleCommandResult(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n',
    );
    const { stdout, stderr } = await commandOutput(cmd);
    expect(stdout).toMatch(/200 OK/);
    expect(stderr).toBe('');
  });

  it('does not throw Cannot read properties of undefined (reading output)', async () => {
    const cmd = sdkStyleCommandResult(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n',
    );
    await expect(commandOutput(cmd)).resolves.toMatchObject({
      stdout: expect.stringContaining('200'),
    });
  });
});

describe('VercelSandboxHttpRunner with SDK-style CommandFinished', () => {
  it('head path works when runCommand returns method-based stdout', async () => {
    const getSandbox: GetSandboxFn = vi.fn(async () =>
      mockSandbox({
        runCommand: vi.fn(async () =>
          sdkStyleCommandResult(
            'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n',
          ),
        ),
      }),
    );
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    const r = await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    await runner.close();
  });
});

describe('VercelSandboxHttpRunner', () => {
  it('get called with name + resume:true; never create-shaped params', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetSandboxFn>(async () => sb);
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-abc',
      getSandbox,
    });
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    expect(getSandbox).toHaveBeenCalledWith({
      name: 'inv-http-abc',
      resume: true,
      signal: undefined,
    });
    const params = getSandbox.mock.calls[0]![0];
    expect(params).not.toHaveProperty('image');
    expect(params).not.toHaveProperty('persistent');
    expect(params).not.toHaveProperty('timeout');
    expect(params).not.toHaveProperty('env');
    await runner.close();
  });

  it('empty name throws before get', () => {
    const getSandbox = vi.fn<GetSandboxFn>(async () => mockSandbox());
    expect(
      () => new VercelSandboxHttpRunner({ name: '  ', getSandbox }),
    ).toThrow(/name is required/i);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('attaches once for two concurrent gets (single-flight)', async () => {
    let attachCount = 0;
    let resolveGet!: (sb: SandboxLike) => void;
    const gate = new Promise<SandboxLike>((r) => {
      resolveGet = r;
    });
    const getSandbox: GetSandboxFn = vi.fn(async () => {
      attachCount += 1;
      return gate;
    });

    const bodySandbox = mockSandbox({
      runCommand: vi.fn(async (cmd: string) => {
        if (cmd === 'curl') {
          return {
            exitCode: 0,
            stdout: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n',
            stderr: '',
          };
        }
        if (cmd === 'head') {
          return { exitCode: 0, stdout: 'ok-body', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    const p1 = runner.get({
      url: 'https://example.com/a',
      maxBytes: 100,
      timeoutMs: 5000,
    });
    const p2 = runner.get({
      url: 'https://example.com/b',
      maxBytes: 100,
      timeoutMs: 5000,
    });
    expect(attachCount).toBe(1);
    resolveGet(bodySandbox);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(attachCount).toBe(1);
    expect(r1.body).toBe('ok-body');
    expect(r2.body).toBe('ok-body');
    await runner.close();
    expect(bodySandbox.stop).not.toHaveBeenCalled();
  });

  it('attach extends timeout; close extends again and never stops', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetSandboxFn>(async () => sb);
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
      idleTimeoutMs: 60_000,
    });
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    const extend = vi.mocked(sb.extendTimeout!);
    expect(extend).toHaveBeenCalledWith(60_000);
    const afterAttach = extend.mock.calls.length;
    await runner.close();
    await runner.close();
    expect(extend.mock.calls.length).toBeGreaterThan(afterAttach);
    expect(sb.stop).not.toHaveBeenCalled();
  });

  it('close during attach does not stop VM', async () => {
    let resolveGet!: (sb: SandboxLike) => void;
    const gate = new Promise<SandboxLike>((r) => {
      resolveGet = r;
    });
    const sb = mockSandbox();
    const getSandbox: GetSandboxFn = vi.fn(async () => gate);

    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    const getPromise = runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });

    const closePromise = runner.close();
    await Promise.resolve();
    resolveGet(sb);
    await closePromise;

    expect(sb.stop).not.toHaveBeenCalled();
    await expect(getPromise).rejects.toThrow(/closed|curl|HTTP/i);
    await runner.close();
    expect(sb.stop).not.toHaveBeenCalled();
  });

  it('default idle timeout is USER_SANDBOX_IDLE family', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetSandboxFn>(async () => sb);
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    expect(vi.mocked(sb.extendTimeout!)).toHaveBeenCalledWith(
      DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS,
    );
    expect(DEFAULT_HTTP_ATTACH_IDLE_TIMEOUT_MS).toBe(USER_SANDBOX_IDLE_TIMEOUT_MS);
    await runner.close();
  });

  it('close after failure still never stops', async () => {
    const sb = mockSandbox({
      runCommand: vi.fn(async () => {
        throw new Error('curl boom');
      }),
    });
    const getSandbox: GetSandboxFn = vi.fn(async () => sb);
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    await expect(
      runner.get({
        url: 'https://example.com/',
        maxBytes: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/curl boom/);
    await runner.close();
    await runner.close();
    expect(sb.stop).not.toHaveBeenCalled();
  });

  it('does not pass secrets in get params env', async () => {
    const getSandbox: GetSandboxFn = vi.fn(async (params) => {
      expect(params).not.toHaveProperty('env');
      const json = JSON.stringify(params);
      expect(json).not.toMatch(/AI_GATEWAY|SANDBOX_TOKEN|Bearer /i);
      return mockSandbox();
    });
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    await runner.close();
  });

  it('passes curl --max-filesize equal to maxBytes on GET', async () => {
    const runCommand = vi.fn(async (cmd: string, args?: string[]) => {
      if (cmd === 'curl') {
        expect(args).toContain('--max-filesize');
        const i = args!.indexOf('--max-filesize');
        expect(args![i + 1]).toBe('2048');
        return {
          exitCode: 0,
          stdout: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n',
          stderr: '',
        };
      }
      if (cmd === 'head') {
        return { exitCode: 0, stdout: 'tiny', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const sb = mockSandbox({ runCommand });
    const getSandbox: GetSandboxFn = vi.fn(async () => sb);
    const runner = new VercelSandboxHttpRunner({
      name: 'inv-http-test',
      getSandbox,
    });
    const r = await runner.get({
      url: 'https://example.com/big',
      maxBytes: 2048,
      timeoutMs: 5000,
    });
    expect(r.body).toBe('tiny');
    expect(runCommand).toHaveBeenCalled();
    await runner.close();
  });

  it('product source has no Sandbox.create / getOrCreate / stop-on-close path', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcText = readFileSync(join(here, 'vercelSandboxHttpRunner.ts'), 'utf8');
    expect(srcText).not.toMatch(/Sandbox\.create\s*\(/);
    expect(srcText).not.toMatch(/\.getOrCreate\s*\(/);
    expect(srcText).not.toMatch(/Sandbox\.getOrCreate\s*\(/);
    expect(srcText).not.toMatch(/await sb\.stop\(/);
    expect(srcText).not.toMatch(/await sb\?\.stop\(/);
  });
});
