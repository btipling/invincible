import { describe, expect, it, vi } from 'vitest';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { createAgentTools } from './tools';

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
    const tools = createAgentTools({ client });
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
    const tools = createAgentTools({ client });
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
    const tools = createAgentTools({ client });
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
    const tools = createAgentTools({ client });
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
      writeFile: vi.fn(async () => ({ ok: true as const, bytes: 2 })),
    });
    const tools = createAgentTools({
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
    }));
    const client = mockClient({ strReplace });
    const tools = createAgentTools({ client });
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
    const tools = createAgentTools({ client, initialCwd: '.' });

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
    const tools = createAgentTools({ client, initialCwd: 'invincible' });
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
    const tools = createAgentTools({ client, initialCwd: 'invincible' });
    const out = (await tools.pwd.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toBe('pwd: invincible');
  });

  it('host-absolute path soft-fails mid-turn', async () => {
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({ client });
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
    const tools = createAgentTools({ client, initialCwd: '.' });
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
    const tools = createAgentTools({ client, initialCwd: 'invincible' });
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
