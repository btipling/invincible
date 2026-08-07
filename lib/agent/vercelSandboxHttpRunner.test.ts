import { describe, expect, it, vi } from 'vitest';
import {
  VercelSandboxHttpRunner,
  parseCurlHeaders,
  type CreateSandboxFn,
  type SandboxLike,
} from './vercelSandboxHttpRunner';
import { MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS } from './builtinHttpConfig';

function mockSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
  return {
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout:
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n',
      stderr: '',
    })),
    stop: vi.fn(async () => ({})),
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
});

describe('VercelSandboxHttpRunner', () => {
  it('creates sandbox once for two concurrent gets (single-flight)', async () => {
    let createCount = 0;
    let resolveCreate!: (sb: SandboxLike) => void;
    const createGate = new Promise<SandboxLike>((r) => {
      resolveCreate = r;
    });
    const createSandbox: CreateSandboxFn = vi.fn(async (params) => {
      createCount += 1;
      expect(params.persistent).toBe(false);
      expect(params.networkPolicy).toBe('allow-all');
      expect(params.timeout).toBeLessThanOrEqual(
        MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
      );
      return createGate;
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

    const runner = new VercelSandboxHttpRunner({ createSandbox });
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
    // Still one create while pending
    expect(createCount).toBe(1);
    resolveCreate(bodySandbox);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(createCount).toBe(1);
    expect(r1.body).toBe('ok-body');
    expect(r2.body).toBe('ok-body');
    await runner.close();
    expect(bodySandbox.stop).toHaveBeenCalledTimes(1);
  });

  it('stop/close is idempotent and runs after failure path', async () => {
    const sb = mockSandbox({
      runCommand: vi.fn(async () => {
        throw new Error('curl boom');
      }),
    });
    const createSandbox: CreateSandboxFn = vi.fn(async () => sb);
    const runner = new VercelSandboxHttpRunner({ createSandbox });
    await expect(
      runner.get({
        url: 'https://example.com/',
        maxBytes: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/curl boom/);
    await runner.close();
    await runner.close();
    expect(sb.stop).toHaveBeenCalledTimes(1);
  });

  it('close during in-flight create still stops the VM (no orphan)', async () => {
    let resolveCreate!: (sb: SandboxLike) => void;
    const createGate = new Promise<SandboxLike>((r) => {
      resolveCreate = r;
    });
    const sb = mockSandbox();
    const createSandbox: CreateSandboxFn = vi.fn(async () => createGate);

    const runner = new VercelSandboxHttpRunner({ createSandbox });
    const getPromise = runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });

    // Abort path: close while Sandbox.create is still pending.
    const closePromise = runner.close();
    // Allow close to park on pending create
    await Promise.resolve();
    resolveCreate(sb);
    await closePromise;

    expect(sb.stop).toHaveBeenCalledTimes(1);
    // In-flight get must not leave runner usable
    await expect(getPromise).rejects.toThrow(/closed|curl|HTTP/i);
    // Second close is idempotent (no double-stop)
    await runner.close();
    expect(sb.stop).toHaveBeenCalledTimes(1);
  });

  it('clamps sandbox create timeout to max 55s', async () => {
    const createSandbox: CreateSandboxFn = vi.fn(async (params) => {
      expect(params.timeout).toBe(MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS);
      return mockSandbox();
    });
    const runner = new VercelSandboxHttpRunner({
      createSandbox,
      sandboxTimeoutMs: 999_999,
    });
    // force create via get with head
    const sb = await (runner as unknown as {
      ensureSandbox: () => Promise<SandboxLike>;
    }).ensureSandbox?.().catch(() => null);
    // use public get head
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    expect(createSandbox).toHaveBeenCalled();
    const arg = (createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.timeout).toBe(MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS);
    await runner.close();
    void sb;
  });

  it('does not pass secrets in create params env', async () => {
    const createSandbox: CreateSandboxFn = vi.fn(async (params) => {
      expect(params).not.toHaveProperty('env');
      return mockSandbox();
    });
    const runner = new VercelSandboxHttpRunner({ createSandbox });
    await runner.get({
      url: 'https://example.com/',
      maxBytes: 0,
      timeoutMs: 1000,
      head: true,
    });
    await runner.close();
  });
});
