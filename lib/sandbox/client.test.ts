import { describe, expect, it, vi } from 'vitest';
import { createSandboxClient } from './client';
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
});
