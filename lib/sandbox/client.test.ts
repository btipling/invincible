import { describe, expect, it, vi } from 'vitest';
import { createSandboxClient, execAbortTimeoutMs } from './client';
import { EXEC_TIMEOUT_BUFFER_MS, MAX_EXEC_TIMEOUT_MS } from './config';
import { SandboxHttpError } from './types';

describe('sandbox client', () => {
  const token = 'test-token-secret-xyz';

  it('list/read/write/exec call correct paths with bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = String(url);
      if (path.endsWith('/v1/list_dir')) {
        return Response.json({ entries: [{ name: 'a', type: 'file' }] });
      }
      if (path.endsWith('/v1/read_file')) {
        return Response.json({ content: 'hi' });
      }
      if (path.endsWith('/v1/write_file')) {
        return Response.json({ ok: true, bytes: 2 });
      }
      if (path.endsWith('/v1/exec')) {
        return Response.json({ exitCode: 0, stdout: 'ok', stderr: '' });
      }
      return new Response('nope', { status: 404 });
    });

    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test/',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listDir('.')).resolves.toEqual({
      entries: [{ name: 'a', type: 'file' }],
    });
    await expect(client.readFile('a.txt')).resolves.toEqual({ content: 'hi' });
    await expect(client.writeFile('a.txt', 'hi')).resolves.toEqual({
      ok: true,
      bytes: 2,
    });
    await expect(client.exec({ cmd: 'node', args: ['-e', '1'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${token}`);
      expect(c.url.startsWith('http://sandbox.test/v1/')).toBe(true);
    }
  });

  it('401 becomes SandboxHttpError without token in message', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listDir()).rejects.toBeInstanceOf(SandboxHttpError);
    try {
      await client.listDir();
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxHttpError);
      expect((err as SandboxHttpError).status).toBe(401);
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('exec merges construction execEnv into body', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      return new Response(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      execEnv: { GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_x', PATH: '/evil' },
    });
    await client.exec({ cmd: 'echo', args: ['hi'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/v1/exec');
    expect(calls[0].body).toEqual({
      cmd: 'echo',
      args: ['hi'],
      env: { GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_x' },
    });
  });

  it('exec omits env when execEnv unset', async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ body });
      return new Response(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.exec({ cmd: 'true' });
    expect(calls[0].body).toEqual({ cmd: 'true' });
    expect(calls[0].body).not.toHaveProperty('env');
  });

  it('exec with stdin probes health and forwards stdin on protocol v2+', async () => {
    const calls: Array<{ method?: string; path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/health') {
        calls.push({ method, path });
        return Response.json({ ok: true, version: 2 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method, path, body });
      return Response.json({ exitCode: 0, stdout: 'fed', stderr: '' });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.exec({ cmd: 'cat', stdin: 'hello\n' }),
    ).resolves.toEqual({ exitCode: 0, stdout: 'fed', stderr: '' });
    expect(calls[0]).toEqual({ method: 'GET', path: '/health' });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/v1/exec',
      body: { cmd: 'cat', stdin: 'hello\n' },
    });
    // Second stdin exec reuses cached health (no extra /health).
    await client.exec({ cmd: 'cat', heredoc: 'again' });
    const healthCalls = calls.filter((c) => c.path === '/health');
    expect(healthCalls).toHaveLength(1);
    expect(calls.at(-1)?.body).toEqual({ cmd: 'cat', stdin: 'again' });
  });

  it('exec with stdin refuses stale protocol v1 daemon', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path === '/health') {
        return Response.json({ ok: true, version: 1 });
      }
      return Response.json({ exitCode: 0, stdout: '', stderr: '' });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.exec({ cmd: 'cat', stdin: 'nope' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/protocol v1.*stdin/i),
    });
    // Must not POST /v1/exec when protocol is too old.
    const posts = vi
      .mocked(fetchImpl)
      .mock.calls.filter((c) => String(c[0]).includes('/v1/exec'));
    expect(posts).toHaveLength(0);
  });

  it('exec client abort deadline follows request timeoutMs (+ buffer), not fixed 45s', async () => {
    // Prove the derived deadline is actually wired into withTimeoutFetch — not only
    // the pure helper. Fake timers: must survive past the old 45s ceiling and only
    // abort at clamp(timeoutMs) + EXEC_TIMEOUT_BUFFER_MS.
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal as AbortSignal | undefined;
            const onAbort = () => {
              aborted = true;
              sig?.removeEventListener('abort', onAbort);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (sig?.aborted) onAbort();
            else sig?.addEventListener('abort', onAbort, { once: true });
          }),
      );
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const pending = client
        .exec({ cmd: 'make', args: ['build'], timeoutMs: 300_000 })
        .then(
          () => null,
          (err: unknown) => err,
        );
      // Daemon still sees the request timeoutMs (not a client-side 45s ceiling).
      const body = vi.mocked(fetchImpl).mock.calls[0][1]?.body;
      expect(JSON.parse(String(body))).toMatchObject({ cmd: 'make', timeoutMs: 300_000 });
      const deadline = execAbortTimeoutMs(300_000)!;
      expect(deadline).toBe(305_000);

      // Old fixed 45s ceiling must not abort.
      await vi.advanceTimersByTimeAsync(45_000);
      expect(aborted).toBe(false);

      // One ms before derived deadline still open.
      await vi.advanceTimersByTimeAsync(deadline - 45_000 - 1);
      expect(aborted).toBe(false);

      // At derived deadline the client aborts (surfaces as 504).
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      const err = await pending;
      expect(err).toBeInstanceOf(SandboxHttpError);
      expect((err as SandboxHttpError).status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exec turn-cancel abort wins immediately over the client timer', async () => {
    let aborted = false;
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          const onAbort = () => {
            aborted = true;
            sig?.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (sig?.aborted) onAbort();
          else sig?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const controller = new AbortController();
    void client
      .exec({ cmd: 'sleep', args: ['10'], timeoutMs: 300_000 }, { signal: controller.signal })
      .catch(() => {});
    controller.abort();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('execAbortTimeoutMs: deadline = clamp(timeoutMs) + buffer', async () => {
    expect(execAbortTimeoutMs(1_000)).toBe(6_000);
    expect(execAbortTimeoutMs(300_000)).toBe(305_000);
    expect(execAbortTimeoutMs(MAX_EXEC_TIMEOUT_MS)).toBe(MAX_EXEC_TIMEOUT_MS + EXEC_TIMEOUT_BUFFER_MS);
    expect(execAbortTimeoutMs(undefined)).toBeUndefined();
    expect(execAbortTimeoutMs(Number.NaN)).toBeUndefined();
    // Non-finite floors behave like the daemon clampTimeout: clamp to MAX.
    expect(execAbortTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      MAX_EXEC_TIMEOUT_MS + EXEC_TIMEOUT_BUFFER_MS,
    );
  });

  it('exec without stdin does not probe health', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      paths.push(String(input).replace(/^https?:\/\/[^/]+/, ''));
      return Response.json({ exitCode: 0, stdout: '', stderr: '' });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.exec({ cmd: 'true' });
    expect(paths).toEqual(['/v1/exec']);
  });
});
