import { describe, expect, it, vi } from 'vitest';
import { createSandboxClient, execAbortTimeoutMs } from './client';
import { EXEC_TIMEOUT_BUFFER_MS, MAX_EXEC_TIMEOUT_MS } from './config';
import { EXPECTED_SANDBOX_DAEMON_VERSION } from './daemonVersion';
import { SandboxHttpError } from './types';

/** Health body served by the fake daemon; daemonVersion omitted → running 0. */
function healthJson(opts: { version?: number; daemonVersion?: number } = {}) {
  const body: Record<string, unknown> = { ok: true, version: opts.version ?? 2 };
  if (opts.daemonVersion !== undefined) {
    body.daemonVersion = opts.daemonVersion;
  }
  return Response.json(body);
}

describe('sandbox client', () => {
  const token = 'test-token-secret-xyz';

  it('list/read/write/stat/exec call correct paths with bearer + expected header', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = String(url);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
      if (path.endsWith('/v1/list_dir')) {
        return Response.json({ entries: [{ name: 'a', type: 'file' }] });
      }
      if (path.endsWith('/v1/read_file')) {
        return Response.json({ content: 'hi', mtimeMs: 1000, size: 2 });
      }
      if (path.endsWith('/v1/write_file')) {
        return Response.json({ ok: true, bytes: 2, mtimeMs: 1001, size: 2 });
      }
      if (path.endsWith('/v1/stat')) {
        return Response.json({
          path: 'a.txt',
          type: 'file',
          mtimeMs: 1000,
          size: 2,
        });
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
    await expect(client.readFile('a.txt')).resolves.toEqual({
      content: 'hi',
      mtimeMs: 1000,
      size: 2,
    });
    await expect(client.writeFile('a.txt', 'hi')).resolves.toEqual({
      ok: true,
      bytes: 2,
      mtimeMs: 1001,
      size: 2,
    });
    await expect(client.stat('a.txt')).resolves.toEqual({
      path: 'a.txt',
      type: 'file',
      mtimeMs: 1000,
      size: 2,
    });
    await expect(client.exec({ cmd: 'node', args: ['-e', '1'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });

    // One health probe + five tool calls.
    expect(calls).toHaveLength(6);
    expect(calls[0].url.endsWith('/health')).toBe(true);
    const toolCalls = calls.filter((c) => c.url.includes('/v1/'));
    expect(toolCalls).toHaveLength(5);
    for (const c of toolCalls) {
      const headers = c.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${token}`);
      expect(headers['x-invincible-expected-daemon-version']).toBe(
        String(EXPECTED_SANDBOX_DAEMON_VERSION),
      );
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
      if (path === '/health') {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
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
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path === '/health') {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
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

  it('events include one health probe; exec with stdin reuses it', async () => {
    const calls: Array<{ method?: string; path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/health') {
        calls.push({ method, path });
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
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
        return healthJson({ version: 1 });
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

  it('daemonVersion missing → 426 exact out-of-date error, no POST', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2 }); // no daemonVersion → running 0
      }
      return Response.json({ ok: true });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listDir()).rejects.toMatchObject({
      status: 426,
      code: 'SANDBOX_DAEMON_OUT_OF_DATE',
      message:
        'Sandbox daemon out of date (running 0, expected ' +
        `${EXPECTED_SANDBOX_DAEMON_VERSION}). Update and restart the sandbox process.`,
    });
    const posts = vi
      .mocked(fetchImpl)
      .mock.calls.filter((c) => String(c[0]).includes('/v1/'));
    expect(posts).toHaveLength(0);
  });

  it('daemonVersion < expected → 426 thrown before the tool POST', async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: 0 });
      }
      posts.push(path);
      return Response.json({ ok: true });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      // Expect a daemon revision beyond what the mock advertises (running 0).
      expectedDaemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION,
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.readFile('a')).rejects.toMatchObject({ status: 426 });
    expect(posts).toHaveLength(0);
  });

  it('daemonVersion >= expected → tools POST as today', async () => {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
      posts.push(path.replace(/^https?:\/\/[^/]+/, ''));
      return Response.json({ entries: [] });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listDir()).resolves.toEqual({ entries: [] });
    expect(posts).toEqual(['/v1/list_dir']);
  });

  it('daemon 426 response → exact SandboxHttpError, no token leak', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
      if (path.endsWith('/v1/list_dir')) {
        return Response.json(
          {
            error: `Sandbox daemon out of date (running 1, expected ${EXPECTED_SANDBOX_DAEMON_VERSION + 1}). Update and restart the sandbox process.`,
            code: 'SANDBOX_DAEMON_OUT_OF_DATE',
            running: 1,
            expected: EXPECTED_SANDBOX_DAEMON_VERSION + 1,
          },
          { status: 426 },
        );
      }
      return Response.json({ ok: true });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listDir()).rejects.toMatchObject({
      status: 426,
      code: 'SANDBOX_DAEMON_OUT_OF_DATE',
      message: expect.stringMatching(/out of date/),
    });
    try {
      await client.listDir();
    } catch (err) {
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('exec client abort deadline follows request timeoutMs (+ buffer), not fixed 45s', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const path = String(input);
          if (path.endsWith('/health')) {
            return Promise.resolve(
              healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION }),
            );
          }
          return new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal as AbortSignal | undefined;
            const onAbort = () => {
              aborted = true;
              sig?.removeEventListener('abort', onAbort);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (sig?.aborted) onAbort();
            else sig?.addEventListener('abort', onAbort, { once: true });
          });
        },
      );
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      // Prime + cache the health probe first, so exec's daemon gate is a no-op
      // and the /v1/exec request reaches the daemon synchronously for the timer test.
      await client.checkDaemonCurrent?.();
      const pending = client
        .exec({ cmd: 'make', args: ['build'], timeoutMs: 300_000 })
        .then(
          () => null,
          (err: unknown) => err,
        );
      // Flush the async gate (cached health) so the /v1/exec request lands.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const body = vi
        .mocked(fetchImpl)
        .mock.calls.find((c) => String(c[0]).endsWith('/v1/exec'))?.[1]?.body;
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
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith('/health')) {
          return Promise.resolve(healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION }));
        }
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          const onAbort = () => {
            aborted = true;
            sig?.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (sig?.aborted) onAbort();
          else sig?.addEventListener('abort', onAbort, { once: true });
        });
      },
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

  it('exec without stdin still gates on daemon health (one probe)', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const p = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (p === '/health') {
        paths.push(p);
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
      paths.push(p);
      return Response.json({ exitCode: 0, stdout: '', stderr: '' });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.exec({ cmd: 'true' });
    expect(paths).toEqual(['/health', '/v1/exec']);
  });

  it('accepts optional fingerprint fields from current daemons', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: EXPECTED_SANDBOX_DAEMON_VERSION });
      }
      if (path.endsWith('/v1/read_file')) {
        return Response.json({ content: 'legacy' });
      }
      if (path.endsWith('/v1/stat')) {
        return Response.json({
          path: 'x',
          type: 'file',
          mtimeMs: 1,
          size: 0,
        });
      }
      return new Response('nope', { status: 404 });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test/',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.readFile('x')).resolves.toEqual({ content: 'legacy' });
    await expect(client.stat('x')).resolves.toMatchObject({ type: 'file', size: 0 });
  });

  describe('workspaceRoot (per-binding R)', () => {
    it('returns the field from cached /health when daemon >= 2', async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/health')) {
          return Response.json({
            ok: true,
            version: 2,
            daemonVersion: 2,
            workspaceRoot: '/vercel/workspace',
          });
        }
        return Response.json({ ok: true });
      });
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.workspaceRoot?.()).resolves.toBe('/vercel/workspace');
    });

    it('v1 daemon (no field) → null', async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/health')) {
          return healthJson({ version: 2, daemonVersion: 1 });
        }
        return Response.json({ ok: true });
      });
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.workspaceRoot?.()).resolves.toBeNull();
    });

    it('malformed / non-absolute / control-char / fake root → null (never a bogus value)', async () => {
      for (const bad of [
        undefined,
        '',
        '   ',
        42,
        null,
        'relative-root',
        './sandbox',
        'C:\\work',
        '/',
        '//',
        '/has/../dotdot',
        '/ok\npath',
        '/vercel/wo\x00rk',
      ]) {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const path = String(input);
          if (path.endsWith('/health')) {
            return Response.json({
              ok: true,
              version: 2,
              daemonVersion: 2,
              ...(bad !== undefined && bad !== null
                ? { workspaceRoot: bad }
                : {}),
            });
          }
          return Response.json({ ok: true });
        });
        const client = createSandboxClient({
          baseUrl: 'http://sandbox.test',
          token,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await expect(client.workspaceRoot?.()).resolves.toBeNull();
      }
    });

    it('non-throwing: a throwing /health probe → null (never propagates)', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('daemon unreachable');
      });
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.workspaceRoot?.()).resolves.toBeNull();
    });

    it('non-throwing: a 5xx /health probe → null', async () => {
      const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.workspaceRoot?.()).resolves.toBeNull();
    });

    it('workspaceRoot probe warms the cache for a later FS gate (single /health)', async () => {
      const healthCalls: string[] = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/health')) {
          healthCalls.push(path);
          return Response.json({
            ok: true,
            version: 2,
            daemonVersion: 2,
            workspaceRoot: '/rw',
          });
        }
        return Response.json({ entries: [] });
      });
      const client = createSandboxClient({
        baseUrl: 'http://sandbox.test',
        token,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(client.workspaceRoot?.()).resolves.toBe('/rw');
      await expect(client.listDir('.')).resolves.toEqual({ entries: [] });
      expect(healthCalls).toHaveLength(1); // reused, not re-probed
    });
  });

  it('checkDaemonCurrent rejects when daemon out of date, passes when current', async () => {
    let backend = 0; // running daemonVersion
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/health')) {
        return healthJson({ version: 2, daemonVersion: backend });
      }
      return Response.json({ ok: true });
    });
    const client = createSandboxClient({
      baseUrl: 'http://sandbox.test',
      token,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.checkDaemonCurrent?.()).rejects.toMatchObject({ status: 426 });
    // After the daemon is upgraded, the same client re-probes (cache was cleared).
    backend = EXPECTED_SANDBOX_DAEMON_VERSION;
    await expect(client.checkDaemonCurrent?.()).resolves.toBeUndefined();
  });
});
