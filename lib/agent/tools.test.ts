import { describe, expect, it, vi } from 'vitest';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { createAgentTools, formatStrReplaceDiffSide, isPathMissingError, STR_REPLACE_DIFF_SIDE_MAX_BYTES } from './tools';
import { createRunFileFreshness } from './fileFreshness';
import { SandboxHttpError } from '../sandbox/types';

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


describe('isPathMissingError', () => {
  it('accepts path-missing messages from BYO and Vercel/Node', () => {
    expect(isPathMissingError(new SandboxHttpError('Path not found', 404))).toBe(true);
    expect(isPathMissingError(new SandboxHttpError('File not found', 404))).toBe(true);
    expect(isPathMissingError(new SandboxHttpError('Directory not found', 404))).toBe(true);
    expect(isPathMissingError(new Error('ENOENT: no such file or directory'))).toBe(true);
    expect(isPathMissingError(new SandboxHttpError('ENOENT: /vercel/workspace/x', 404))).toBe(
      true,
    );
  });

  it('rejects protocol/route 404 and ambiguous not-found', () => {
    expect(isPathMissingError(new SandboxHttpError('Not found', 404))).toBe(false);
    expect(isPathMissingError(new SandboxHttpError('Sandbox request failed (404)', 404))).toBe(
      false,
    );
    expect(isPathMissingError(new SandboxHttpError('old_string not found in file', 400))).toBe(
      false,
    );
    expect(isPathMissingError(new SandboxHttpError('Unauthorized', 401))).toBe(false);
  });
});

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

  it('soft-fails with the out-of-date message when client throws 426', async () => {
    const message =
      'Sandbox daemon out of date (running 0, expected 1). Update and restart the sandbox process.';
    const client = mockClient({
      listDir: vi.fn(async () => {
        throw new SandboxHttpError(message, 426, 'SANDBOX_DAEMON_OUT_OF_DATE');
      }),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
    });
    const out = (await tools.list_dir.execute!({ path: '.' }, {
      toolCallId: '1',
      messages: [],
    } as never)) as string;
    expect(out).toMatch(/^ERROR list_dir:/);
    expect(out).toContain('Sandbox daemon out of date');
    expect(out).toMatch(/running 0, expected 1/);
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

  it('rewrites exec stdout/stderr under the jail root to workspace-relative (exec pwd ≡ pwd)', async () => {
    const R = '/var/lib/invincible-sandbox/workspace';
    const client = mockClient({
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: `${R}/invincible/docs\n`,
        stderr: `${R}/invincible/error.txt\n`,
      })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      workspaceRoot: R,
    });
    const out = (await tools.exec.execute!(
      { cmd: 'pwd' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toContain('stdout:\ninvincible/docs');
    expect(out).toContain('stderr:\ninvincible/error.txt');
    expect(out).not.toContain(R);
  });

  it('exec output is byte-identical when workspaceRoot is absent (fail-open parity)', async () => {
    const R = '/var/lib/invincible-sandbox/workspace';
    const client = mockClient({
      exec: vi.fn(async () => ({ exitCode: 0, stdout: `${R}/x\n`, stderr: '' })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
    });
    const out = (await tools.exec.execute!(
      { cmd: 'pwd' },
      { toolCallId: 'r', messages: [] } as never,
    )) as string;
    expect(out).toContain(`${R}/x`);
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
    expect(out).toContain('\n-old_string\nfoo\n+new_string\nbar');
    expect(strReplace).toHaveBeenCalledWith(
      'a.ts',
      'foo',
      'bar',
      true,
      expect.objectContaining({ signal: undefined }),
    );
  });
});

describe('str_replace audit diff (plan #665)', () => {
  async function runReplace(
    oldString: string,
    newString: string,
    secrets?: Array<string | undefined | null>,
  ): Promise<string> {
    const client = mockClient({
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.ts',
        replacements: 1,
        bytes: 10,
        mtimeMs: 5,
        size: 10,
      })),
      readFile: vi.fn(async () => ({ content: oldString, mtimeMs: 5, size: oldString.length })),
      stat: vi.fn(async () => ({
        path: 'a.ts',
        type: 'file' as const,
        mtimeMs: 5,
        size: oldString.length,
      })),
    });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      secrets,
    });
    await tools.read_file.execute!(
      { path: 'a.ts' },
      { toolCallId: 'sr-read', messages: [] } as never,
    );
    return (await tools.str_replace.execute!(
      { path: 'a.ts', old_string: oldString, new_string: newString },
      { toolCallId: 'sr-write', messages: [] } as never,
    )) as string;
  }

  it('appends -old_string / +new_string headers around the sides', async () => {
    const out = await runReplace('alpha', 'beta');
    expect(out).toMatch(/^str_replace a\.ts: ok replacements=1 bytes=10\n/);
    expect(out).toContain('\n-old_string\nalpha\n+new_string\nbeta');
  });

  it('redacts old_string in the diff block', async () => {
    const secret = 'sk-live-old-token-aaaa';
    const out = await runReplace(`const k = '${secret}'`, "const k = 'ok'", [secret]);
    expect(out).toContain('\n-old_string\n');
    expect(out).not.toContain(secret);
    expect(out).toContain("const k = '[redacted]'");
  });

  it('redacts new_string in the diff block', async () => {
    const secret = 'sk-live-new-token-bbbb';
    const out = await runReplace('const k = 1', `const k = '${secret}'`, [secret]);
    expect(out).toContain('\n+new_string\n');
    expect(out).not.toContain(secret);
    expect(out).toContain("const k = '[redacted]'");
  });

  it('caps old_string at 4 KiB with a truncation marker', async () => {
    const oldString = 'o'.repeat(STR_REPLACE_DIFF_SIDE_MAX_BYTES + 80);
    const out = await runReplace(oldString, 'new');
    const oldBlock = out.split('\n-old_string\n')[1]!.split('\n+new_string\n')[0]!;
    expect(oldBlock.endsWith('… (truncated)')).toBe(true);
    const body = oldBlock.slice(0, -'… (truncated)'.length);
    expect(Buffer.byteLength(body, 'utf8')).toBe(STR_REPLACE_DIFF_SIDE_MAX_BYTES);
    expect(oldBlock).not.toContain('o'.repeat(STR_REPLACE_DIFF_SIDE_MAX_BYTES + 1));
  });

  it('caps new_string at 4 KiB with a truncation marker', async () => {
    const newString = 'n'.repeat(STR_REPLACE_DIFF_SIDE_MAX_BYTES + 80);
    const out = await runReplace('old', newString);
    const newBlock = out.split('\n+new_string\n')[1]!;
    expect(newBlock.endsWith('… (truncated)')).toBe(true);
    const body = newBlock.slice(0, -'… (truncated)'.length);
    expect(Buffer.byteLength(body, 'utf8')).toBe(STR_REPLACE_DIFF_SIDE_MAX_BYTES);
  });

  it('formatStrReplaceDiffSide redacts then caps independently of finalize', () => {
    const secret = 'sk-side-secret-cccc';
    const raw = `${secret}${'x'.repeat(STR_REPLACE_DIFF_SIDE_MAX_BYTES)}`;
    const side = formatStrReplaceDiffSide(raw, [secret]);
    expect(side).not.toContain(secret);
    expect(side.startsWith('[redacted]')).toBe(true);
    expect(side.endsWith('… (truncated)')).toBe(true);
    expect(STR_REPLACE_DIFF_SIDE_MAX_BYTES).toBe(4096);
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

  it('host-absolute path soft-fails mid-turn when R is unavailable', async () => {
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(), client });
    const out = (await tools.read_file.execute!(
      { path: '/etc/passwd' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toMatch(/^ERROR read_file:/);
    expect(out).toMatch(/root unavailable — use a workspace-relative path/);
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

  it('#466 change_dir to an exact ancestor re-roots instead of a phantom nested path', async () => {
    const listDir = vi.fn(async (path?: string) => {
      if (path === 'invincible') {
        return { entries: [{ name: 'docs', type: 'dir' as const }] };
      }
      return { entries: [] };
    });
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      initialCwd: 'invincible/docs',
    });

    const cd = (await tools.change_dir.execute!(
      { path: 'invincible' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/change_dir invincible: ok cwd=invincible/);

    const pwd = (await tools.pwd.execute!(
      {},
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(pwd).toBe('pwd: invincible');
  });

  it('#466 change_dir to a sibling sharing a name prefix does NOT re-root', async () => {
    const listDir = vi.fn(async () => ({ entries: [] }));
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      initialCwd: 'foobar/x',
    });
    const cd = (await tools.change_dir.execute!(
      { path: 'foo' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(cd).toMatch(/change_dir foobar\/x\/foo: ok cwd=foobar\/x\/foo/);
  });

  it('#466 change_dir `..` still walks up; at root still escapes', async () => {
    const listDir = vi.fn(async () => ({ entries: [] }));
    const client = mockClient({ listDir });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      initialCwd: 'invincible/docs',
    });
    const up = (await tools.change_dir.execute!(
      { path: '..' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(up).toMatch(/change_dir invincible: ok cwd=invincible/);

    const tools2 = createAgentTools({
      freshness: createRunFileFreshness(),
      client: mockClient({ listDir }),
      initialCwd: '.',
    });
    const esc = (await tools2.change_dir.execute!(
      { path: '..' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(esc).toMatch(/^ERROR change_dir:/);
    expect(esc).toMatch(/escapes/);
  });

  it('#466 exec cwd shares the ancestor re-root seam (uniform resolve)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      initialCwd: 'invincible/docs',
    });
    await tools.exec.execute!(
      { cmd: 'pwd', cwd: 'invincible' },
      { toolCallId: '1', messages: [] } as never,
    );
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'pwd', cwd: 'invincible' }),
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

  it('stat route 404 "Not found" fail-closes write_file (no create bypass)', async () => {
    // Stale BYO daemon without POST /v1/stat → createServer unknown route
    const writeFile = vi.fn(async () => ({ ok: true as const, bytes: 1 }));
    const client = mockClient({
      writeFile,
      stat: vi.fn(async () => {
        throw new SandboxHttpError('Not found', 404);
      }),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.write_file.execute!(
      { path: 'existing.txt', content: 'overwrite' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^ERROR write_file: Not found/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('ENOENT from stat still allows create-new write_file', async () => {
    const writeFile = vi.fn(async () => ({
      ok: true as const,
      bytes: 2,
      mtimeMs: 1,
      size: 2,
    }));
    const client = mockClient({
      writeFile,
      stat: vi.fn(async () => {
        throw new SandboxHttpError('ENOENT: /vercel/workspace/new.txt', 404);
      }),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.write_file.execute!(
      { path: 'new.txt', content: 'hi' },
      execCtx,
    )) as string;
    expect(out).toMatch(/^write_file new\.txt/);
    expect(writeFile).toHaveBeenCalled();
  });
});

describe('createAgentTools in-jail absolute paths', () => {
  const ROOT = '/vercel/workspace';
  const ectx = { toolCallId: '1', messages: [] } as never;

  it('read_file in-jail absolute resolves to the same relative path for the client', async () => {
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: ROOT,
    });
    const out = (await tools.read_file.execute!(
      { path: `${ROOT}/src/foo.ts` },
      ectx,
    )) as string;
    expect(out).toMatch(/^read_file src\/foo\.ts/);
    expect(readFile).toHaveBeenCalledWith('src/foo.ts', undefined, expect.anything());
  });

  it('list_dir / change_dir / exec cwd accept the in-jail absolute form', async () => {
    const listDir = vi.fn(async (path?: string) =>
      path === 'src' ? { entries: [{ name: 'foo.ts', type: 'file' as const }] } : { entries: [] },
    );
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ listDir, exec });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: ROOT,
    });

    const l = (await tools.list_dir.execute!({ path: `${ROOT}/src` }, ectx)) as string;
    expect(l).toContain('1 entries');
    expect(listDir).toHaveBeenCalledWith('src', expect.anything());

    const cd = (await tools.change_dir.execute!({ path: `${ROOT}/src` }, ectx)) as string;
    expect(cd).toMatch(/change_dir src: ok cwd=src/);

    const cd2 = (await tools.change_dir.execute!({ path: `${ROOT}/` }, ectx)) as string;
    expect(cd2).toMatch(/change_dir \.: ok cwd=\./);

    await tools.exec.execute!({ cmd: 'true', cwd: `${ROOT}/src` }, ectx);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'true', cwd: 'src' }),
      expect.anything(),
    );
  });

  it('out-of-jail absolute with R present fails closed with a clear escape error', async () => {
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: ROOT,
    });
    const out = (await tools.read_file.execute!(
      { path: '/etc/passwd' },
      ectx,
    )) as string;
    expect(out).toMatch(/^ERROR read_file:/);
    expect(out).toMatch(/escapes workspace root/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('write_file in-jail absolute then str_replace relative share the freshness key', async () => {
    let created = false;
    let mtime = 1000;
    let size = 11;
    let content = 'hello world';
    const client = mockClient({
      stat: vi.fn(async (path: string) => {
        if (path !== 'a.txt' || !created) {
          throw new SandboxHttpError('Path not found', 404);
        }
        return { path: 'a.txt', type: 'file' as const, mtimeMs: mtime, size };
      }),
      writeFile: vi.fn(async (_p: string, c: string) => {
        created = true;
        content = c;
        size = Buffer.byteLength(c, 'utf8');
        mtime += 1;
        return { ok: true as const, bytes: size, mtimeMs: mtime, size };
      }),
      strReplace: vi.fn(async () => {
        content = content.replace('hello', 'HELLO');
        size = Buffer.byteLength(content, 'utf8');
        mtime += 1;
        return { ok: true as const, path: 'a.txt', replacements: 1, bytes: size, mtimeMs: mtime, size };
      }),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: ROOT,
    });

    const w = (await tools.write_file.execute!(
      { path: `${ROOT}/a.txt`, content: 'hello world' },
      ectx,
    )) as string;
    expect(w).toMatch(/^write_file a\.txt/);
    expect(client.writeFile).toHaveBeenCalledWith(
      'a.txt',
      'hello world',
      undefined,
      expect.anything(),
    );

    const s = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'hello', new_string: 'HELLO' },
      ectx,
    )) as string;
    expect(s).toMatch(/^str_replace a\.txt/);
    expect(client.strReplace).toHaveBeenCalledWith(
      'a.txt',
      'hello',
      'HELLO',
      undefined,
      expect.anything(),
    );
  });

  it('str_replace absolute after a relative read shares the freshness key', async () => {
    let mtime = 1000;
    const size = 11;
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: 'hello world', mtimeMs: mtime, size })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: mtime,
        size,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: size,
        mtimeMs: mtime,
        size,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: ROOT,
    });
    await tools.read_file.execute!({ path: 'a.txt' }, ectx);
    const out = (await tools.str_replace.execute!(
      { path: `${ROOT}/a.txt`, old_string: 'hello', new_string: 'HELLO' },
      ectx,
    )) as string;
    expect(out).toMatch(/^str_replace a\.txt/);
    expect(client.strReplace).toHaveBeenCalledWith('a.txt', 'hello', 'HELLO', undefined, expect.anything());
  });

  it('#403 cross-feed: read_file via the exec pwd host-absolute (realpath BYO root) is re-entrant', async () => {
    // Same realpath jail-root shape as workPath.test.ts — the model passes the
    // exact <R>/invincible/... string `exec pwd` / find / a stack printed.
    const R = '/var/lib/invincible-sandbox/workspace';
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ readFile });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      workspaceRoot: R,
    });
    const out = (await tools.read_file.execute!(
      { path: `${R}/invincible/docs/sandbox.md` },
      ectx,
    )) as string;
    expect(out).toMatch(/^read_file invincible\/docs\/sandbox\.md/);
    expect(readFile).toHaveBeenCalledWith(
      'invincible/docs/sandbox.md',
      undefined,
      expect.anything(),
    );
  });
});

describe('str_replace write serialization (bug #479)', () => {
  const ectx = { toolCallId: '1', messages: [] } as never;

  /** Daemon-shaped in-memory client whose stat reflects real disk state
   * (fp bumps only on writes), with a delay window so a non-serialized pair
   * can both read the same snapshot before either writes. */
  function fakeFsClient(initial: Record<string, string>): {
    client: SandboxClient;
    read(path: string): string;
  } {
    const store = new Map<string, string>(Object.entries(initial));
    const seq = new Map<string, number>();
    const fpOf = (p: string) => ({
      mtimeMs: seq.get(p) ?? 0,
      size: Buffer.byteLength(store.get(p) ?? '', 'utf8'),
    });
    const client = mockClient({
      readFile: vi.fn(async (p: string) => ({ content: store.get(p) ?? '', ...fpOf(p) })),
      stat: vi.fn(async (p: string) => ({
        path: p,
        type: 'file' as const,
        ...fpOf(p),
      })),
      writeFile: vi.fn(async (p: string, c: string) => {
        await new Promise((r) => setTimeout(r, 3));
        store.set(p, c);
        seq.set(p, (seq.get(p) ?? 0) + 1);
        return {
          ok: true as const,
          path: p,
          bytes: Buffer.byteLength(c, 'utf8'),
          ...fpOf(p),
        };
      }),
      strReplace: vi.fn(
        async (
          p: string,
          oldS: string,
          newS: string,
          replaceAll?: boolean,
        ) => {
          await new Promise((r) => setTimeout(r, 5));
          const content = store.get(p) ?? '';
          let count = 0;
          let from = 0;
          while (from <= content.length) {
            const idx = content.indexOf(oldS, from);
            if (idx === -1) break;
            count += 1;
            from = idx + oldS.length;
          }
          if (count === 0) {
            throw new SandboxHttpError('old_string not found in file', 400);
          }
          if (count > 1 && !replaceAll) {
            throw new SandboxHttpError(
              `old_string matched ${count} times; pass replace_all: true or provide a unique snippet`,
              409,
            );
          }
          const next = replaceAll
            ? content.split(oldS).join(newS)
            : content.replace(oldS, newS);
          store.set(p, next);
          seq.set(p, (seq.get(p) ?? 0) + 1);
          return {
            ok: true as const,
            path: p,
            replacements: replaceAll ? count : 1,
            bytes: Buffer.byteLength(next, 'utf8'),
            ...fpOf(p),
          };
        },
      ),
    });
    return { client, read: (p: string) => store.get(p) ?? '' };
  }

  // Lost-update repro: disjoint concurrent same-path applies must both land on
  // disk (serialized order on latest bytes) — never two `ok` with one dropped.
  it('two disjoint concurrent same-path str_replace both land (no lost update)', async () => {
    const fs = fakeFsClient({ 'a.ts': 'foo bar' });
    const tools = createAgentTools({
      client: fs.client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.ts' }, ectx);

    const [ra, rb] = await Promise.all([
      tools.str_replace.execute!(
        { path: 'a.ts', old_string: 'foo', new_string: 'X' },
        ectx,
      ),
      tools.str_replace.execute!(
        { path: 'a.ts', old_string: 'bar', new_string: 'Y' },
        ectx,
      ),
    ]);
    const results = [ra as string, rb as string];
    // Both edits are present in the final bytes (a silent last-writer-win would
    // leave only one — this assertion fails on the un-locked baseline).
    expect(fs.read('a.ts')).toBe('X Y');
    // And no hunk was reported ok while missing from disk.
    const oks = results.filter((s) => s.startsWith('str_replace '));
    const errs = results.filter((s) => s.startsWith('ERROR str_replace'));
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + errs.length).toBe(2);
  });

  // Overlap → loser re-validates on the winner's bytes: same old_string cannot
  // both apply; exactly one wins, the loser fail-closes.
  it('concurrent same-hunk replace → exactly one ok, loser fail-closes', async () => {
    const fs = fakeFsClient({ 'a.ts': 'foo' });
    const tools = createAgentTools({
      client: fs.client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.ts' }, ectx);

    const [ra, rb] = await Promise.all([
      tools.str_replace.execute!(
        { path: 'a.ts', old_string: 'foo', new_string: 'X' },
        ectx,
      ),
      tools.str_replace.execute!(
        { path: 'a.ts', old_string: 'foo', new_string: 'Y' },
        ectx,
      ),
    ]);
    const results = [ra as string, rb as string];
    const ok = results.filter((s) => s.startsWith('str_replace ')).length;
    const err = results.filter((s) => s.startsWith('ERROR str_replace')).length;
    expect(ok).toBe(1);
    expect(err).toBeGreaterThanOrEqual(1);
    expect(['X', 'Y']).toContain(fs.read('a.ts'));
  });

  // replace_all + unique replace on the same path → defined concatenation,
  // counts evaluated on the bytes actually written.
  it('replace_all + unique concurrent replace → defined concatenation on latest bytes', async () => {
    const fs = fakeFsClient({ 'a.ts': 'aa aa bb' });
    const tools = createAgentTools({
      client: fs.client,
      freshness: createRunFileFreshness(),
    });
    await tools.read_file.execute!({ path: 'a.ts' }, ectx);

    const [ra, rb] = await Promise.all([
      tools.str_replace.execute!(
        {
          path: 'a.ts',
          old_string: 'aa',
          new_string: 'XX',
          replace_all: true,
        },
        ectx,
      ),
      tools.str_replace.execute!(
        { path: 'a.ts', old_string: 'bb', new_string: 'YY' },
        ectx,
      ),
    ]);
    void [ra, rb];
    expect(fs.read('a.ts')).toBe('XX XX YY');
  });
});
