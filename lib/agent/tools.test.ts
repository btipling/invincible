import { describe, expect, it, vi } from 'vitest';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { createAgentTools, formatLineWindow, formatStrReplaceDiffSide, isFullFileReadGrant, isPathMissingError, READ_FILE_DEFAULT_LIMIT, STR_REPLACE_DIFF_SIDE_MAX_BYTES } from './tools';
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

  it('escapes a content line that equals +new_string so the header stays unique', async () => {
    const out = await runReplace('keep\n+new_string\nstill-old', 'fresh');
    expect(out).toContain('\n-old_string\nkeep\n +new_string\nstill-old\n+new_string\nfresh');
    const oldBlock = out.split('\n-old_string\n')[1]!.split('\n+new_string\n')[0]!;
    expect(oldBlock).toContain(' +new_string');
    expect(oldBlock).not.toMatch(/^\+new_string$/m);
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
    expect(out).toContain('read_file invincible/sandbox/x.ts');
    expect(out).toContain('cwd=invincible:');
    expect(out).toMatch(/offset=1 limit=1000 lines=/);
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
    expect(out).toMatch(/^ERROR str_replace a\.txt: read_file required/);
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
    expect(stale).toMatch(/^ERROR str_replace a\.txt: file changed since last read_file/);
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
    expect(out).toMatch(/^ERROR str_replace a\.txt: read_file required/);
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

describe('read_file line window (plan #689)', () => {
  const execCtx = { toolCallId: '1', messages: [] } as never;

  function nLines(n: number, prefix = 'L'): string {
    return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');
  }

  it('formatLineWindow numbers a mid-file slice', () => {
    const w = formatLineWindow(nLines(50), 40, 20);
    expect(w.returned).toBe(11);
    expect(w.totalLines).toBe(50);
    expect(w.body.startsWith('40→L40')).toBe(true);
    expect(w.body.endsWith('50→L50')).toBe(true);
    expect(w.body).not.toContain('39→');
  });

  it('isFullFileReadGrant: offset>1 never grants even at EOF', () => {
    expect(
      isFullFileReadGrant({
        offset: 40,
        returned: 11,
        totalLines: 50,
        byteTruncated: false,
      }),
    ).toBe(false);
    expect(
      isFullFileReadGrant({
        offset: 1,
        returned: 50,
        totalLines: 50,
        byteTruncated: false,
      }),
    ).toBe(true);
    expect(
      isFullFileReadGrant({
        offset: 1,
        returned: 1000,
        totalLines: 1000,
        byteTruncated: false,
      }),
    ).toBe(true);
    // window clipped by display limit but daemon returned full content → grant
    expect(
      isFullFileReadGrant({
        offset: 1,
        returned: 1000,
        totalLines: 1400,
        byteTruncated: false,
      }),
    ).toBe(true);
    expect(
      isFullFileReadGrant({
        offset: 1,
        returned: 50,
        totalLines: 50,
        byteTruncated: true,
      }),
    ).toBe(false);
  });

  it('defaults: 50-line file grants edit', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(50),
        mtimeMs: 1,
        size: 100,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 100,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 100,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!({ path: 'a.txt' }, execCtx)) as string;
    expect(out).toMatch(
      /^read_file a\.txt offset=1 limit=1000 lines=50\/50:\n1→L1/,
    );
    expect(out).not.toContain('(truncated)');
    expect(out).toContain('50→L50');
    const edit = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace a\.txt: ok/);
  });
  it('defaults: 1400-line file with default limit grants edit but shows (truncated) + hint', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(1400),
        mtimeMs: 1,
        size: 10_000,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'big.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 10_000,
      })),
      stat: vi.fn(async () => ({
        path: 'big.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 10_000,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!({ path: 'big.txt' }, execCtx)) as string;
    // Grant still given (offset=1, not byte-truncated) but window clips → (truncated) + hint
    expect(out).toMatch(
      /^read_file big\.txt offset=1 limit=1000 lines=1000\/1400 \(truncated\) — use limit>=1400 to read all lines:/,
    );
    expect(out).toContain('1→L1');
    expect(out).toContain('1000→L1000');
    expect(out).not.toContain('1001→');
    // edit should succeed — grant is based on offset=1 + no byte trunc, not line window
    const edit = (await tools.str_replace.execute!(
      { path: 'big.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace big\.txt: ok/);
  });

  it('defaults: exactly 1000 lines grants', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(READ_FILE_DEFAULT_LIMIT),
        mtimeMs: 1,
        size: 4000,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 4000,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 4000,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!({ path: 'a.txt' }, execCtx)) as string;
    expect(out).toMatch(
      /^read_file a\.txt offset=1 limit=1000 lines=1000\/1000:/,
    );
    expect(out).not.toContain('(truncated)');
    const edit = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace a\.txt: ok/);
  });

  it('offset=40 limit=20 returns those lines and never grants', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(50),
        mtimeMs: 1,
        size: 100,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 100,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!(
      { path: 'a.txt', offset: 40, limit: 20 },
      execCtx,
    )) as string;
    expect(out).toMatch(
      /^read_file a\.txt offset=40 limit=20 lines=11\/50 \(truncated\):/,
    );
    expect(out).toContain('40→L40');
    expect(out).toContain('50→L50');
    expect(out).not.toContain('39→');
    const edit = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'L40', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/truncated read_file/);
  });

  it('offset=1 limit=20 on 50-line file grants edit but shows (truncated) + hint', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(50),
        mtimeMs: 1,
        size: 100,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 100,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 100,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!(
      { path: 'a.txt', offset: 1, limit: 20 },
      execCtx,
    )) as string;
    // Grant given (offset=1, not byte-truncated) but window clips at 20/50 → (truncated) + hint
    expect(out).toMatch(
      /^read_file a\.txt offset=1 limit=20 lines=20\/50 \(truncated\) — use limit>=50 to read all lines:/,
    );
    const edit = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace a\.txt: ok/);
  });
  it('offset past EOF is empty + truncated', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: nLines(10), mtimeMs: 1, size: 20 })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!(
      { path: 'a.txt', offset: 99, limit: 10 },
      execCtx,
    )) as string;
    expect(out).toMatch(
      /^read_file a\.txt offset=99 limit=10 lines=0\/10 \(truncated\):\n$/,
    );
  });

  it('maxBytes byte-truncation denies grant regardless of lines', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(3),
        truncated: true,
        mtimeMs: 1,
        size: 999,
      })),
      stat: vi.fn(async () => ({
        path: 'big.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 999,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!({ path: 'big.txt' }, execCtx)) as string;
    expect(out).toContain('(truncated)');
    const edit = (await tools.str_replace.execute!(
      { path: 'big.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/truncated read_file/);
  });

  it('invalid offset/limit clamp to defaults', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: nLines(3), mtimeMs: 1, size: 6 })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!(
      { path: 'a.txt', offset: -4, limit: 0 },
      execCtx,
    )) as string;
    expect(out).toMatch(/offset=1 limit=1000 lines=3\/3:/);
  });

  it('redacts secrets in numbered lines', async () => {
    const secret = 'sk-super-secret';
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: `token=${secret}`,
        mtimeMs: 1,
        size: 20,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
      secrets: [secret],
    });
    const out = (await tools.read_file.execute!({ path: 'a.txt' }, execCtx)) as string;
    expect(out).toContain('1→token=');
    expect(out).not.toContain(secret);
  });

  it('full read then windowed peek does not revoke edit grant (Major #1)', async () => {
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content: nLines(50),
        mtimeMs: 1,
        size: 100,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 'a.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 100,
      })),
      stat: vi.fn(async () => ({
        path: 'a.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 100,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    // Full read → grant
    const r1 = (await tools.read_file.execute!({ path: 'a.txt' }, execCtx)) as string;
    expect(r1).not.toContain('(truncated)');
    // Windowed peek → must NOT revoke the grant
    const r2 = (await tools.read_file.execute!(
      { path: 'a.txt', offset: 40, limit: 10 },
      execCtx,
    )) as string;
    expect(r2).toContain('(truncated)');
    // Edit still works
    const edit = (await tools.str_replace.execute!(
      { path: 'a.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace a\.txt: ok/);
  });

  it('trailing-newline 1000-line file grants edit but shows (truncated) + hint at default limit', async () => {
    const content = nLines(READ_FILE_DEFAULT_LIMIT) + '\n'; // POSIX trailing newline → 1001 lines
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content,
        mtimeMs: 1,
        size: 4000,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 't.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 4000,
      })),
      stat: vi.fn(async () => ({
        path: 't.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 4000,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!({ path: 't.txt' }, execCtx)) as string;
    // trailing \n makes 1001 lines, default limit clips to 1000 — grant given, but (truncated) + hint
    expect(out).toMatch(
      /\(truncated\) — use limit>=1001 to read all lines:/,
    );
    const edit = (await tools.str_replace.execute!(
      { path: 't.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace t\.txt: ok/);
  });

  it('trailing-newline 1000-line file grants with limit=1001', async () => {
    const content = nLines(READ_FILE_DEFAULT_LIMIT) + '\n'; // POSIX trailing newline
    const client = mockClient({
      readFile: vi.fn(async () => ({
        content,
        mtimeMs: 1,
        size: 4000,
      })),
      strReplace: vi.fn(async () => ({
        ok: true as const,
        path: 't.txt',
        replacements: 1,
        bytes: 2,
        mtimeMs: 1,
        size: 4000,
      })),
      stat: vi.fn(async () => ({
        path: 't.txt',
        type: 'file' as const,
        mtimeMs: 1,
        size: 4000,
      })),
    });
    const tools = createAgentTools({
      client,
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.read_file.execute!(
      { path: 't.txt', limit: READ_FILE_DEFAULT_LIMIT + 1 },
      execCtx,
    )) as string;
    expect(out).toMatch(/lines=1001\/1001:/);
    expect(out).not.toContain('(truncated)');
    const edit = (await tools.str_replace.execute!(
      { path: 't.txt', old_string: 'L1', new_string: 'X' },
      execCtx,
    )) as string;
    expect(edit).toMatch(/^str_replace t\.txt: ok/);
  });
});

describe('createAgentTools sandbox_info', () => {
  const execCtx = { toolCallId: '1', messages: [] } as never;
  const envStdout = [
    'PATH=/usr/bin:/jail/ws/node_modules/.bin',
    'LANG=C.UTF-8',
    'GITHUB_TOKEN=ghp_secret',
  ].join('\n');

  function infoClient(partial: Partial<SandboxClient> = {}): SandboxClient {
    return mockClient({
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: envStdout,
        stderr: '',
      })),
      ...partial,
    });
  }

  it('read deny', async () => {
    const tools = createAgentTools({
      client: infoClient(),
      freshness: createRunFileFreshness(),
      permissions: { canRead: false, canWrite: false },
    });
    const out = (await tools.sandbox_info.execute!({}, execCtx)) as string;
    expect(out).toMatch(/^ERROR sandbox_info: permission denied \(need read\)/);
  });

  it('write-false + read-true still dumps env (internal exec)', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'FOO=1\n',
      stderr: '',
    }));
    const tools = createAgentTools({
      client: infoClient({ exec }),
      freshness: createRunFileFreshness(),
      permissions: { canRead: true, canWrite: false },
      workspaceRoot: '/jail/ws',
    });
    const out = (await tools.sandbox_info.execute!({}, execCtx)) as string;
    expect(exec).toHaveBeenCalledWith(
      { cmd: 'env', timeoutMs: 10_000 },
      expect.anything(),
    );
    expect(out).toContain('permissions.write=false');
    expect(out).toContain('capabilities.exec=false');
    expect(out).toContain('env.FOO=1');
    expect(out).toMatch(/capabilities\.path_tools=.*sandbox_info/);
    expect(out).not.toMatch(/capabilities\.path_tools=.*write_file/);
    expect(out).not.toMatch(/capabilities\.path_tools=.*\bstat\b/);
  });

  it('env exec fail → bind/cwd still present, env unavailable, no stderr echo', async () => {
    const tools = createAgentTools({
      client: infoClient({
        exec: vi.fn(async () => {
          throw new Error('boom /jail/ws secret-token-value');
        }),
      }),
      freshness: createRunFileFreshness(),
      secrets: ['secret-token-value'],
      bind: {
        backend: 'byo',
        sandboxId: 'sb-1',
        name: 'prod',
        slug: 'prod',
        status: 'active',
      },
      cwdState: { current: 'invincible' },
      workspaceRoot: '/jail/ws',
    });
    const out = (await tools.sandbox_info.execute!({}, execCtx)) as string;
    expect(out).toMatch(/^sandbox_info:/);
    expect(out).toContain('backend=byo');
    expect(out).toContain('id=sb-1');
    expect(out).toContain('name=prod');
    expect(out).toContain('cwd=invincible');
    expect(out).toContain('env: unavailable (error)');
    expect(out).not.toContain('/jail/ws');
    expect(out).not.toContain('secret-token-value');
    expect(out).not.toContain('boom');
  });

  it('thrown 504 → env: unavailable (timeout)', async () => {
    const tools = createAgentTools({
      client: infoClient({
        exec: vi.fn(async () => {
          throw new SandboxHttpError('Sandbox request aborted or timed out', 504);
        }),
      }),
      freshness: createRunFileFreshness(),
    });
    const out = (await tools.sandbox_info.execute!({}, execCtx)) as string;
    expect(out).toContain('env: unavailable (timeout)');
    expect(out).not.toContain('aborted');
  });

  it('missing bind still returns cwd + env', async () => {
    const tools = createAgentTools({
      client: infoClient(),
      freshness: createRunFileFreshness(),
      workspaceRoot: '/jail/ws',
    });
    const out = (await tools.sandbox_info.execute!({}, execCtx)) as string;
    expect(out).toMatch(/^sandbox_info:/);
    expect(out).toContain('cwd=.');
    expect(out).toContain('env.LANG=C.UTF-8');
    expect(out).toContain('env.PATH=["/usr/bin","node_modules/.bin"]');
    expect(out).not.toMatch(/^backend=/m);
    expect(out).not.toMatch(/^id=/m);
    expect(out).not.toMatch(/^name=/m);
    expect(out).not.toContain('GITHUB_TOKEN');
    expect(out).not.toContain('ghp_secret');
  });

  it('BYO daemonInfo maps protocol vs version (unequal) and vercel omits', async () => {
    const daemonInfo = vi.fn(async () => ({ version: 2, daemonVersion: 1 }));
    const byo = createAgentTools({
      client: infoClient({ daemonInfo }),
      freshness: createRunFileFreshness(),
      bind: {
        backend: 'byo',
        sandboxId: 'sb-1',
        name: 'prod',
        slug: 'prod',
        status: 'active',
      },
    });
    const byoOut = (await byo.sandbox_info.execute!({}, execCtx)) as string;
    expect(byoOut).toContain('daemon.protocol=2');
    expect(byoOut).toContain('daemon.version=1');
    expect(byoOut).toContain('daemon.out_of_date=true');
    expect(byoOut).toContain('capabilities.stdin=true');

    const vercel = createAgentTools({
      client: infoClient({ daemonInfo }),
      freshness: createRunFileFreshness(),
      bind: {
        backend: 'vercel',
        sandboxId: 'sb-2',
        name: 'ws',
        slug: 'ws',
        status: 'active',
        image: 'vercel/sandbox/universal:latest',
      },
    });
    const vercelOut = (await vercel.sandbox_info.execute!({}, execCtx)) as string;
    expect(vercelOut).toContain('daemon=none');
    expect(vercelOut).toContain('capabilities.stdin=false');
    expect(vercelOut).toContain('image=vercel/sandbox/universal:latest');
    expect(vercelOut).not.toContain('daemon.protocol=');
    expect(daemonInfo).toHaveBeenCalledTimes(1); // vercel short-circuit
  });
});

describe('createAgentTools search', () => {
  const ectx = { toolCallId: '1', messages: [] } as never;

  it('forwards correct rg argv with caps, globs and resolved path', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'a.ts:1:hello\nb.ts:2:world\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client, workspaceRoot: '/ws' });
    const out = (await tools.search.execute!({ pattern: 'hello', glob: ['*.ts'], path: 'src' }, ectx)) as string;

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'rg',
      args: expect.arrayContaining([
        '-n', '--no-heading', '--max-count', '20', '--max-filesize', '1M',
        '-S', '-g', '*.ts', '-e', 'hello', '--', 'src',
      ]),
    }), expect.anything());
    expect(out).toContain('search src: 2 hits');
    expect(out).toContain('a.ts:1:hello');
  });

  it('read-grant-only: denied when canRead=false', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: false, canWrite: false },
    });
    const out = (await tools.search.execute!({ pattern: 'x' }, ectx)) as string;
    expect(out).toMatch(/^ERROR search: permission denied \(need read\)/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('search available with read-only grant', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'f.ts:3:match\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      permissions: { canRead: true, canWrite: false },
    });
    const out = (await tools.search.execute!({ pattern: 'match' }, ectx)) as string;
    expect(out).toContain('search .: 1 hit');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('no matches → 0 hits (rg exit 1, not error)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: 'no-match-xyz' }, ectx)) as string;
    expect(out).toContain('search .: 0 hits');
    expect(out).not.toMatch(/^ERROR/);
  });

  it('hit cap → truncated + N more when rows exceed SEARCH_MAX_RESULTS', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(`f.ts:${i + 1}:line ${i}`);
    }
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: 'line' }, ectx)) as string;
    expect(out).toContain('search .: 200 hits');
    expect(out).toContain('(truncated, 50 more)');
  });

  it('per-line cap clips long line with …', async () => {
    const longText = 'x'.repeat(400);
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: `a.ts:1:${longText}\n`, stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: 'x' }, ectx)) as string;
    expect(out).toContain('search .: 1 hit');
    // The line text should be clipped (≤ SEARCH_LINE_MAX_BYTES + '…')
    const bodyLine = out.split('\n').find((l) => l.startsWith('a.ts:1:'));
    expect(bodyLine).toBeDefined();
    const textPart = bodyLine!.split(':').slice(2).join(':');
    expect(textPart.length).toBeLessThanOrEqual(210);
    expect(textPart).toContain('…');
  });

  it('path resolve: relative, in-jail-abs works; out-of-jail fails closed', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'x.ts:1:hi\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client, workspaceRoot: '/ws' });

    // relative
    const r = (await tools.search.execute!({ pattern: 'hi', path: 'src' }, ectx)) as string;
    expect(r).toContain('search src: 1 hit');
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['src']) }), expect.anything());

    // in-jail-abs
    vi.clearAllMocks();
    const a = (await tools.search.execute!({ pattern: 'hi', path: '/ws/src' }, ectx)) as string;
    expect(a).toContain('search src: 1 hit');

    // out-of-jail
    const o = (await tools.search.execute!({ pattern: 'hi', path: '/etc' }, ectx)) as string;
    expect(o).toContain('ERROR search');
    expect(o).toContain('escapes workspace root');
  });

  it('schema has no cmd field; argv is always hard-built rg', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    // additionalProperties:false ensures a model-supplied cmd is ignored
    const out = (await tools.search.execute!({ pattern: 'x', cmd: 'evil' } as never, ectx)) as string;
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'rg' }), expect.anything());
    expect(out).not.toMatch(/^ERROR search: pattern/);
  });

  it('soft-fails on rg non-zero/non-1 exit (bad regex)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'rg: invalid regex\n' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: '[' }, ectx)) as string;
    expect(out).toMatch(/^ERROR search:/);
  });

  it('soft-fails on client error without throwing', async () => {
    const exec = vi.fn(async () => {
      throw new Error('boom search-token-xyz');
    });
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      secrets: ['search-token-xyz'],
    });
    const out = (await tools.search.execute!({ pattern: 'x' }, ectx)) as string;
    expect(out).toMatch(/^ERROR search:/);
    expect(out).not.toContain('search-token-xyz');
    expect(out).toContain('[redacted]');
  });

  it('rg-missing fallback → error with guidance', async () => {
    const exec = vi.fn(async () => ({ exitCode: 127, stdout: '', stderr: 'rg: command not found\n' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: 'x' }, ectx)) as string;
    expect(out).toMatch(/^ERROR search:/);
    expect(out).toContain('rg not available');
  });

  it('secrets redacted from search results', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'env.ts:1:SECRET=my-token-abc\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      secrets: ['my-token-abc'],
    });
    const out = (await tools.search.execute!({ pattern: 'SECRET' }, ectx)) as string;
    expect(out).not.toContain('my-token-abc');
    expect(out).toContain('[redacted]');
  });

  it('search respects max_results input cap', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`f.ts:${i + 1}:line ${i}`);
    }
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });
    const out = (await tools.search.execute!({ pattern: 'line', max_results: 10 }, ectx)) as string;
    expect(out).toContain('search .: 10 hits');
    expect(out).toContain('(truncated, 40 more)');
  });

  it('pattern is always passed after -e and path after -- (flag injection prevention)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({ freshness: createRunFileFreshness(), client });

    // A model-supplied pattern that looks like an rg flag
    await tools.search.execute!({ pattern: '--pre=/bin/sh' }, ectx);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'rg',
        args: expect.arrayContaining(['-e', '--pre=/bin/sh', '--']),
      }),
      expect.anything(),
    );
    // Verify ordering: -e before pattern, -- before path
    const args = (exec.mock.calls[0] as unknown as [{ args: string[] }])[0].args;
    const eIdx = args.indexOf('-e');
    const dashDashIdx = args.indexOf('--');
    expect(eIdx).toBeGreaterThan(0);
    expect(dashDashIdx).toBeGreaterThan(eIdx);
    expect(args[eIdx + 1]).toBe('--pre=/bin/sh');
    expect(args[dashDashIdx + 1]).toBe('.');
  });

  it('cwd is jail root (.) not logical cwd (no double-join)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'f.ts:1:x\n', stderr: '' }));
    const client = mockClient({ exec });
    const tools = createAgentTools({
      freshness: createRunFileFreshness(),
      client,
      cwdState: { current: 'lib' },
    });

    const out = (await tools.search.execute!({ pattern: 'x' }, ectx)) as string;
    expect(out).toContain('search lib cwd=lib: 1 hit');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '.', args: expect.arrayContaining(['lib']) }),
      expect.anything(),
    );
  });
});

