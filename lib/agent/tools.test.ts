import { describe, expect, it, vi } from 'vitest';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { createAgentTools } from './tools';
import { createRunFileFreshness } from './fileFreshness';
import { SandboxHttpError } from '../sandbox/types';

function toolsWith(
  client: SandboxClient,
  extra?: Partial<Parameters<typeof createAgentTools>[0]>,
) {
  return createAgentTools({
    client,
    freshness: createRunFileFreshness(),
    ...extra,
  });
}

function mockClient(partial: Partial<SandboxClient>): SandboxClient {
  return {
    listDir: vi.fn(async () => ({ entries: [] })),
    readFile: vi.fn(async () => ({ content: '' })),
    writeFile: vi.fn(async () => ({ ok: true as const, bytes: 0 })),
    strReplace: vi.fn(async () => ({
      ok: true as const,
      path: 'a.ts',
      replacements: 1,
      bytes: 10,
    })),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    stat: vi.fn(async () => ({
      path: '.',
      type: 'file' as const,
      mtimeMs: 0,
      size: 0,
    })),
    ...partial,
  };
}

describe('createAgentTools', () => {
  it('soft-fails on client error without throwing', async () => {
    const client = mockClient({
      listDir: vi.fn(async () => {
        throw new Error('boom secret-token-value');
      }),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      secrets: ['secret-token-value'],
    });
    const out = await tools.list_dir.execute!({ path: '.' }, {
      toolCallId: '1',
      messages: [],
    } as never);
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/^ERROR list_dir:/);
    expect(out as string).not.toContain('secret-token-value');
    expect(out as string).toContain('[redacted]');
  });

  it('includes timed out exec in result text', async () => {
    const client = mockClient({
      exec: vi.fn(async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.exec.execute!(
      { cmd: 'sleep', args: ['99'], timeoutMs: 100 },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toContain('TIMED_OUT');
  });

  it('truncates huge tool results', async () => {
    const big = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: big })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.read_file.execute!(
      { path: 'big.txt' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 20);
    expect(out).toContain('…[truncated]');
  });

  it('list_dir success path', async () => {
    const client = mockClient({
      listDir: vi.fn(async () => ({
        entries: [
          { name: 'a.ts', type: 'file' as const },
          { name: 'b', type: 'dir' as const },
        ],
      })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.list_dir.execute!(
      { path: '.' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toContain('2 entries');
    expect(out).toContain('a.ts');
  });

  it('exec tool schema has no env (additionalProperties false, no env key)', () => {
    const client = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    } as unknown as SandboxClient;
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const execTool = tools.exec as {
      inputSchema?: {
        jsonSchema?: {
          properties?: Record<string, unknown>;
          additionalProperties?: boolean;
        };
      };
    };
    const js = execTool.inputSchema?.jsonSchema;
    expect(js).toBeDefined();
    expect(js!.additionalProperties).toBe(false);
    expect(js!.properties).toBeDefined();
    expect(js!.properties).not.toHaveProperty('env');
    expect(Object.keys(js!.properties!)).toEqual(
      expect.arrayContaining(['cmd', 'args', 'cwd', 'timeoutMs']),
    );
  });

  it('exec rejects a shell-string cmd (no args) with a clear argv-only error', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.exec.execute!(
      { cmd: 'grep -r foo .' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toMatch(/^ERROR exec:/);
    expect(out).toMatch(/argv only \(no shell\)/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('exec forwards timeoutMs and args for a normal argv invocation', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.exec.execute!(
      { cmd: 'grep', args: ['-r', 'foo', '.'], timeoutMs: 120_000 },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'grep', args: ['-r', 'foo', '.'], timeoutMs: 120_000 }),
      expect.anything(),
    );
    expect(out).toContain('exec grep');
  });
});

describe('createAgentTools permissions', () => {
  it('read-only denies write_file, str_replace and exec without calling client', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, bytes: 1 }));
    const strReplace = vi.fn(async () => ({
      ok: true as const,
      path: 'a',
      replacements: 1,
      bytes: 1,
    }));
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const listDir = vi.fn(async () => ({ entries: [{ name: 'a', type: 'file' as const }] }));
    const client = mockClient({ writeFile, strReplace, exec, listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: true, canWrite: false },
    });

    const w = (await tools.write_file.execute!(
      { path: 'x.txt', content: 'hi' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(w).toMatch(/permission denied \(need write\)/);
    expect(writeFile).not.toHaveBeenCalled();

    const e = (await tools.exec.execute!(
      { cmd: 'true' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(e).toMatch(/permission denied \(need write\)/);
    expect(exec).not.toHaveBeenCalled();

    const l = (await tools.list_dir.execute!(
      { path: '.' },
      { toolCallId: '3', messages: [] } as never,
    )) as string;
    expect(l).toContain('1 entries');
    expect(listDir).toHaveBeenCalled();
  });

  it('write-only effective caller allows all when canRead true canWrite true', async () => {
    // Caller passes *effective* flags (write⇒read already applied)
    const client = mockClient({
      listDir: vi.fn(async () => ({ entries: [] })),
      writeFile: vi.fn(async () => ({ ok: true as const, bytes: 2, mtimeMs: 1, size: 2 })),
      // Create path — no prior read required
      stat: vi.fn(async () => {
        throw new SandboxHttpError('Path not found', 404);
      }),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: true, canWrite: true },
    });
    const l = (await tools.list_dir.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(l).toContain('0 entries');
    const w = (await tools.write_file.execute!(
      { path: 'a', content: 'b' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(w).toContain('ok bytes=2');
  });

  it('no-read denies list/read', async () => {
    const listDir = vi.fn(async () => ({ entries: [] }));
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ listDir, readFile });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: false, canWrite: false },
    });
    const l = (await tools.list_dir.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(l).toMatch(/permission denied \(need read\)/);
    expect(listDir).not.toHaveBeenCalled();
    const r = (await tools.read_file.execute!(
      { path: 'a' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(r).toMatch(/permission denied \(need read\)/);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe('str_replace tool', () => {
  it('returns ok summary on success', async () => {
    const strReplace = vi.fn(async () => ({
      ok: true as const,
      path: 'a.ts',
      replacements: 2,
      bytes: 99,
      mtimeMs: 5,
      size: 99,
    }));
    const client = mockClient({
      strReplace,
      readFile: vi.fn(async () => ({ content: 'foo', mtimeMs: 5, size: 3 })),
      stat: vi.fn(async () => ({
        path: 'a.ts',
        type: 'file' as const,
        mtimeMs: 5,
        size: 3,
      })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
    });
    await tools.read_file.execute!(
      { path: 'a.ts' },
      { toolCallId: 'sr0', messages: [] } as never,
    );
    const out = (await tools.str_replace.execute!(
      {
        path: 'a.ts',
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      },
      { toolCallId: 'sr1', messages: [] } as never,
    )) as string;
    expect(out).toMatch(/str_replace a\.ts: ok replacements=2 bytes=99/);
    expect(strReplace).toHaveBeenCalledWith(
      'a.ts',
      'foo',
      'bar',
      true,
      expect.objectContaining({ signal: undefined }),
    );
  });
});

describe('createAgentTools cwd', () => {
  it('change_dir then read_file joins path for client', async () => {
    const listDir = vi.fn(async (path?: string) => {
      if (path === 'invincible') {
        return { entries: [{ name: 'sandbox', type: 'dir' as const }] };
      }
      return { entries: [] };
    });
    const readFile = vi.fn(async () => ({ content: 'ok' }));
    const client = mockClient({ listDir, readFile });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client, initialCwd: '.' });

    const cd = (await tools.change_dir.execute!(
      { path: 'invincible' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/change_dir invincible: ok cwd=invincible/);

    const out = (await tools.read_file.execute!(
      { path: 'sandbox/x.ts' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(readFile).toHaveBeenCalledWith(
      'invincible/sandbox/x.ts',
      undefined,
      expect.anything(),
    );
    expect(out).toContain('read_file invincible/sandbox/x.ts cwd=invincible:');
    expect(out).toContain('ok');
  });

  it('does not double-prefix already-rooted paths under cwd', async () => {
    const readFile = vi.fn(async () => ({ content: 'body' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client, initialCwd: 'invincible' });
    await tools.read_file.execute!(
      { path: 'invincible/a.ts' },
      { toolCallId: '1', messages: [] } as never,
    );
    expect(readFile).toHaveBeenCalledWith(
      'invincible/a.ts',
      undefined,
      expect.anything(),
    );
  });

  it('pwd reports current cwd', async () => {
    const client = mockClient({});
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client, initialCwd: 'invincible' });
    const out = (await tools.pwd.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toBe('pwd: invincible');
  });

  it('host-absolute path soft-fails mid-turn', async () => {
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.read_file.execute!(
      { path: '/etc/passwd' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toMatch(/^ERROR read_file:/);
    expect(out).toMatch(/absolute|not allowed/i);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('change_dir failure does not mutate cwd', async () => {
    const listDir = vi.fn(async () => {
      throw new Error('Directory not found');
    });
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client, initialCwd: '.' });
    const cd = (await tools.change_dir.execute!(
      { path: 'missing' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/^ERROR change_dir:/);
    const pwd = (await tools.pwd.execute!(
      {},
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(pwd).toBe('pwd: .');
  });

  it('read-only grant allows change_dir', async () => {
    const listDir = vi.fn(async () => ({
      entries: [{ name: 'a', type: 'dir' as const }],
    }));
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: true, canWrite: false },
    });
    const cd = (await tools.change_dir.execute!(
      { path: 'proj' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/ok cwd=proj/);
    expect(listDir).toHaveBeenCalledWith('proj', expect.anything());
  });

  it('no-read denies change_dir and pwd', async () => {
    const listDir = vi.fn(async () => ({ entries: [] }));
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: false, canWrite: false },
    });
    const cd = (await tools.change_dir.execute!(
      { path: 'x' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/permission denied \(need read\)/);
    expect(listDir).not.toHaveBeenCalled();
    const pwd = (await tools.pwd.execute!(
      {},
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(pwd).toMatch(/permission denied \(need read\)/);
  });

  it('exec defaults cwd to logical cwd', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client, initialCwd: 'invincible' });
    await tools.exec.execute!(
      { cmd: 'true' },
      { toolCallId: '1', messages: [] } as never,
    );
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'true', cwd: 'invincible' }),
      expect.anything(),
    );
  });
});

describe('exec stdin / heredoc', () => {
  it('passes stdin to sandbox client', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.exec.execute!(
      { cmd: 'python3', args: ['-'], stdin: 'print(1)\n' },
      { toolCallId: 'e1', messages: [] } as never,
    )) as string;
    expect(out).toContain('stdin=');
    expect(out).toContain('exit=0');
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'python3',
        args: ['-'],
        stdin: 'print(1)\n',
      }),
      expect.anything(),
    );
  });

  it('maps heredoc alias to stdin', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    await tools.exec.execute!(
      { cmd: 'cat', heredoc: 'hello' },
      { toolCallId: 'e2', messages: [] } as never,
    );
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'cat', stdin: 'hello' }),
      expect.anything(),
    );
  });

  it('prefers stdin over heredoc when both are set', async () => {
    let seen: Record<string, unknown> | undefined;
    const exec = vi.fn(async (req: Record<string, unknown>) => {
      seen = req;
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    await tools.exec.execute!(
      { cmd: 'cat', stdin: 'primary', heredoc: 'alias' },
      { toolCallId: 'e3', messages: [] } as never,
    );
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'cat', stdin: 'primary' }),
      expect.anything(),
    );
    expect(seen).toBeDefined();
    expect(seen).toEqual(
      expect.objectContaining({ cmd: 'cat', stdin: 'primary' }),
    );
    expect(seen).not.toHaveProperty('heredoc');
  });
});

describe('read-before-edit gates', () => {
  const execCtx = { toolCallId: '1', messages: [] } as never;

  function fpClient(overrides: Partial<SandboxClient> = {}): SandboxClient {
    let mtime = 1000;
    let size = 11;
    let content = 'hello world';
    return mockClient({
      readFile: vi.fn(async () => ({ content, mtimeMs: mtime, size })),
      writeFile: vi.fn(async (_p, c) => {
        content = c;
        size = Buffer.byteLength(c, 'utf8');
        mtime += 1;
        return { ok: true as const, bytes: size, mtimeMs: mtime, size };
      }),
      strReplace: vi.fn(async () => {
        content = content.replace('hello', 'HELLO');
        size = Buffer.byteLength(content, 'utf8');
        mtime += 1;
        return {
          ok: true as const,
          path: 'a.txt',
          replacements: 1,
          bytes: size,
          mtimeMs: mtime,
          size,
        };
      }),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: mtime,
        size,
      })),
      ...overrides,
    });
  }

  it('str_replace without read → ERROR read_required', async () => {
    const client = fpClient();
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^ERROR str_replace: read_file required/);
    expect(client.strReplace).not.toHaveBeenCalled();
  });

  it('read then str_replace OK', async () => {
    const client = fpClient();
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    const out = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^str_replace a\.txt/);
    expect(client.strReplace).toHaveBeenCalled();
  });

  it('read → disk mtime bump → stale → re-read → OK', async () => {
    let mtime = 1000;
    const size = 11;
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: 'hello world',
        mtimeMs: mtime,
        size,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: size,
        mtimeMs: mtime + 1,
        size,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: mtime,
        size,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    mtime = 2000; // external change
    const stale = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(stale).toMatch(/^ERROR str_replace: file changed since last read_file/);
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    const ok = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(ok).toMatch(/^str_replace a\.txt/);
  });

  it('write_file create OK; existing without read ERROR', async () => {
    const client = mockClient({
      stat: vi.fn(async (path: string) => {
        if (path === 'new.txt') {
          throw new SandboxHttpError('Path not found', 404);
        }
        return { path, type: 'file' as const, mtimeMs: 1, size: 2 };
      }),
      writeFile: vi.fn(async () => ({
        ok: true as const,
        bytes: 2,
        mtimeMs: 3,
        size: 2,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const created = (await tools.write_file.execute!(
      { path: 'new.txt', content: 'hi' },
      execCtx,
    )) as string;
    expect(created).toMatch(/^write_file new\.txt/);
    const denied = (await tools.write_file.execute!(
      { path: 'old.txt', content: 'x' },
      execCtx,
    )) as string;
    expect(denied).toMatch(/^ERROR write_file: read_file required/);
  });

  it('own write refreshes; second edit OK', async () => {
    const client = fpClient();
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    const w1 = (await tools.write_file.execute!(
      { path: 'a.txt', content: 'hello world!' },
      execCtx,
    )) as string;
    expect(w1).toMatch(/^write_file a\.txt/);
    const w2 = (await tools.write_file.execute!(
      { path: 'a.txt', content: 'hello world!!' },
      execCtx,
    )) as string;
    expect(w2).toMatch(/^write_file a\.txt/);
  });

  it('truncated read no grant', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: 'abcd',
        truncated: true,
        mtimeMs: 1,
        size: 100,
      })),
      stat: vi.fn(async () => ({
        path: 'big.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 100,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'big.txt' }, execCtx);
    const out = (await tools.str_replace.execute!(
      { path: 'big.txt', old_string: 'a', new_string: 'b' },
      execCtx,
    )) as string;
    expect(out).toMatch(/truncated read_file/);
  });

  it('shared freshness: read via A, edit via B OK', async () => {
    const client = fpClient();
    const freshness = createRunFileFreshness();
    const A = createAgentTools({ client, freshness });
    const B = createAgentTools({ client, freshness });
    await A.read_file.execute!({ path: 'a.txt' }, execCtx);
    const out = (await B.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^str_replace a\.txt/);
  });

  it('isolated freshness: read via A, edit via B with new object → ERROR', async () => {
    const client = fpClient();
    const A = createAgentTools({ client, freshness: createRunFileFreshness() });
    const B = createAgentTools({ client, freshness: createRunFileFreshness() });
    await A.read_file.execute!({ path: 'a.txt' }, execCtx);
    const out = (await B.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^ERROR str_replace: read_file required/);
  });

  it('read omits mtime; stat supplies it → stale detect works', async () => {
    let mtime = 50;
    const size = 4;
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: 'abcd' })), // no fingerprint
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: 4,
        mtimeMs: mtime,
        size,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: mtime,
        size,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    mtime = 99;
    const stale = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'a', new_string: 'b' },
      execCtx,
    )) as string;
    expect(stale).toMatch(/file changed since last read_file/);
  });

  it('write result omits fp; post-mutate stat fills ledger', async () => {
    let mtime = 10;
    let size = 2;
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: 'hi',
        mtimeMs: mtime,
        size,
      })),
      writeFile: vi.fn(async () => {
        mtime = 11;
        size = 3;
        return { ok: true as const, bytes: 3 }; // no fingerprint fields
      }),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: mtime,
        size,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.txt' }, execCtx);
    const w = (await tools.write_file.execute!(
      { path: 'a.txt', content: 'hey' },
      execCtx,
    )) as string;
    expect(w).toMatch(/^write_file a\.txt/);
    // second write should use filled ledger (mtime 11)
    const w2 = (await tools.write_file.execute!(
      { path: 'a.txt', content: 'hey!' },
      execCtx,
    )) as string;
    expect(w2).toMatch(/^write_file a\.txt/);
    expect(client.stat).toHaveBeenCalled();
  });
});
