import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STDIO_BYTES } from './constants.mjs';
import { JailError } from './paths.mjs';
import {
  ToolError,
  buildExecEnv,
  execCmd,
  listDir,
  parseExecEnvOverlay,
  readFileTool,
  statTool,
  strReplaceTool,
  writeFileTool,
} from './tools.mjs';

describe('sandbox tools', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function mkWorkspace(): Promise<string> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-tools-'));
    return tmp;
  }

  it('write + read + list roundtrip', async () => {
    const ws = await mkWorkspace();
    const w = await writeFileTool(ws, {
      path: 'hello.txt',
      content: 'hello world',
    });
    expect(w.ok).toBe(true);
    expect(w.bytes).toBe(Buffer.byteLength('hello world'));
    expect(typeof w.mtimeMs).toBe('number');
    expect(Number.isInteger(w.mtimeMs)).toBe(true);
    expect(w.size).toBe(Buffer.byteLength('hello world'));

    const r = await readFileTool(ws, { path: 'hello.txt' });
    expect(r.content).toBe('hello world');
    expect(r.truncated).toBeUndefined();
    expect(typeof r.mtimeMs).toBe('number');
    expect(Number.isInteger(r.mtimeMs)).toBe(true);
    expect(r.size).toBe(Buffer.byteLength('hello world'));

    const list = await listDir(ws, { path: '.' });
    expect(list.entries).toContainEqual({ name: 'hello.txt', type: 'file' });
  });

  it('write with mkdir creates nested dirs', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, {
      path: 'a/b/c.txt',
      content: 'nested',
      mkdir: true,
    });
    const r = await readFileTool(ws, { path: 'a/b/c.txt' });
    expect(r.content).toBe('nested');
  });

  it('rejects jail escape on write', async () => {
    const ws = await mkWorkspace();
    await expect(
      writeFileTool(ws, { path: '../escape.txt', content: 'x' }),
    ).rejects.toThrow(JailError);
  });

  it('read truncates at maxBytes', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'big.txt', content: 'abcdefghij' });
    const r = await readFileTool(ws, { path: 'big.txt', maxBytes: 4 });
    expect(r.content).toBe('abcd');
    expect(r.truncated).toBe(true);
  });

  it('exec runs node -e', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('exec times out and sets timedOut', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)'],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 15_000);

  it('exec caps stdout at 32KiB', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: [
        '-e',
        `process.stdout.write(Buffer.alloc(${MAX_STDIO_BYTES + 4096}, 0x61))`,
      ],
      timeoutMs: 5000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_STDIO_BYTES);
    // utf8 'a' is 1 byte each
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_STDIO_BYTES);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('exec rejects jailed cwd escape', async () => {
    const ws = await mkWorkspace();
    await expect(
      execCmd(ws, { cmd: process.execPath, args: ['-e', '1'], cwd: '..' }),
    ).rejects.toThrow(JailError);
  });

  it('blocks symlink read escape', async () => {
    const ws = await mkWorkspace();
    await fs.symlink('/etc/passwd', path.join(ws, 'passwd-link'));
    await expect(readFileTool(ws, { path: 'passwd-link' })).rejects.toThrow(
      JailError,
    );
  });

  it('blocks symlink write escape', async () => {
    const ws = await mkWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-out-'));
    try {
      await fs.symlink(outside, path.join(ws, 'out'));
      await expect(
        writeFileTool(ws, { path: 'out/pwned.txt', content: 'x' }),
      ).rejects.toThrow(JailError);
      await expect(
        fs.readFile(path.join(outside, 'pwned.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('exec feeds stdin (heredoc) to the child', async () => {
    const ws = await mkWorkspace();
    const payload = 'line1\nline2\n';
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: ['-e', 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{process.stdout.write(s); process.exit(0);});'],
      stdin: payload,
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(payload);
  });

  it('exec accepts heredoc alias for stdin', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: ['-e', 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{process.stdout.write(s); process.exit(0);});'],
      heredoc: 'via-heredoc',
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('via-heredoc');
  });

  it('exec prefers stdin over heredoc when both are set', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: [
        '-e',
        'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{process.stdout.write(s); process.exit(0);});',
      ],
      stdin: 'from-stdin',
      heredoc: 'from-heredoc',
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('from-stdin');
  });

  it('exec rejects non-string stdin', async () => {
    const ws = await mkWorkspace();
    await expect(
      execCmd(ws, {
        cmd: process.execPath,
        args: ['-e', '1'],
        // @ts-expect-error intentional bad type
        stdin: 123,
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('exec rejects oversized stdin', async () => {
    const ws = await mkWorkspace();
    const huge = 'x'.repeat(MAX_STDIO_BYTES + 1);
    await expect(
      execCmd(ws, {
        cmd: process.execPath,
        args: ['-e', '1'],
        stdin: huge,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('exec does not inherit SANDBOX_TOKEN or host secrets', async () => {
    const ws = await mkWorkspace();
    const prevToken = process.env.SANDBOX_TOKEN;
    const prevKey = process.env.AI_GATEWAY_API_KEY;
    process.env.SANDBOX_TOKEN = 'should-not-leak';
    process.env.AI_GATEWAY_API_KEY = 'gateway-should-not-leak';
    try {
      const result = await execCmd(ws, {
        cmd: process.execPath,
        args: [
          '-e',
          'process.stdout.write(String(process.env.SANDBOX_TOKEN)+"|"+String(process.env.AI_GATEWAY_API_KEY))',
        ],
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('undefined|undefined');
    } finally {
      if (prevToken === undefined) delete process.env.SANDBOX_TOKEN;
      else process.env.SANDBOX_TOKEN = prevToken;
      if (prevKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = prevKey;
    }
  });

  it('exec merges allowlisted env overlay (GH_TOKEN / GITHUB_TOKEN)', async () => {
    const ws = await mkWorkspace();
    const result = await execCmd(ws, {
      cmd: process.execPath,
      args: [
        '-e',
        'process.stdout.write(String(process.env.GH_TOKEN)+"|"+String(process.env.GITHUB_TOKEN))',
      ],
      env: { GH_TOKEN: 'ghp_test_pat', GITHUB_TOKEN: 'ghp_test_pat' },
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ghp_test_pat|ghp_test_pat');
  });

  it('exec rejects unknown env keys and empty values', async () => {
    const ws = await mkWorkspace();
    await expect(
      execCmd(ws, {
        cmd: process.execPath,
        args: ['-e', '1'],
        env: { PATH: '/evil' },
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ name: 'ToolError', status: 400 });

    await expect(
      execCmd(ws, {
        cmd: process.execPath,
        args: ['-e', '1'],
        env: { GH_TOKEN: '' },
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ name: 'ToolError', status: 400 });
  });

  it('parseExecEnvOverlay and buildExecEnv helpers', () => {
    expect(parseExecEnvOverlay(undefined)).toBeNull();
    expect(parseExecEnvOverlay({ GH_TOKEN: 'x' })).toEqual({ GH_TOKEN: 'x' });
    expect(() => parseExecEnvOverlay({ FOO: 'bar' })).toThrow(ToolError);
    const env = buildExecEnv('/tmp/ws', { GH_TOKEN: 't', GITHUB_TOKEN: 't' });
    expect(env.GH_TOKEN).toBe('t');
    expect(env.HOME).toBe('/tmp/ws');
    expect(env.SANDBOX_TOKEN).toBeUndefined();
  });


  it('str_replace unique match', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'a.ts', content: 'const x = 1;\nconst y = 2;\n' });
    const r = await strReplaceTool(ws, {
      path: 'a.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    });
    expect(r.replacements).toBe(1);
    const read = await readFileTool(ws, { path: 'a.ts' });
    expect(read.content).toContain('const x = 42;');
    expect(read.content).toContain('const y = 2;');
  });

  it('str_replace multi without replace_all fails', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'b.ts', content: 'aa aa aa' });
    await expect(
      strReplaceTool(ws, { path: 'b.ts', old_string: 'aa', new_string: 'bb' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('str_replace replace_all', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'c.ts', content: 'aa aa aa' });
    const r = await strReplaceTool(ws, {
      path: 'c.ts',
      old_string: 'aa',
      new_string: 'bb',
      replace_all: true,
    });
    expect(r.replacements).toBe(3);
    const read = await readFileTool(ws, { path: 'c.ts' });
    expect(read.content).toBe('bb bb bb');
  });

  it('str_replace not found and empty old', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'd.ts', content: 'hello' });
    await expect(
      strReplaceTool(ws, { path: 'd.ts', old_string: 'nope', new_string: 'x' }),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(
      strReplaceTool(ws, { path: 'd.ts', old_string: '', new_string: 'x' }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('str_replace rejects jail escape', async () => {
    const ws = await mkWorkspace();
    await expect(
      strReplaceTool(ws, {
        path: '../x',
        old_string: 'a',
        new_string: 'b',
      }),
    ).rejects.toThrow(JailError);
  });

  it('serializes concurrent same-path str_replace (no lost update)', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'f.txt', content: 'foo bar' });
    const [ra, rb] = await Promise.all([
      strReplaceTool(ws, { path: 'f.txt', old_string: 'foo', new_string: 'X' }),
      strReplaceTool(ws, { path: 'f.txt', old_string: 'bar', new_string: 'Y' }),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    const r = await readFileTool(ws, { path: 'f.txt' });
    // Both replacements present (defined order, latest bytes) — not a torn/lost one.
    expect(r.content).toBe('X Y');
  });

  it('fail-closes a concurrent same-hunk replace the winner consumed', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'g.txt', content: 'foo bar' });
    let okCount = 0;
    let errCount = 0;
    await Promise.all([
      strReplaceTool(ws, {
        path: 'g.txt',
        old_string: 'foo',
        new_string: 'X',
      }).then(
        () => {
          okCount += 1;
        },
        () => {
          errCount += 1;
        },
      ),
      strReplaceTool(ws, {
        path: 'g.txt',
        old_string: 'foo',
        new_string: 'Y',
      }).then(
        () => {
          okCount += 1;
        },
        () => {
          errCount += 1;
        },
      ),
    ]);
    // Exactly one wins; the loser re-reads the winner's bytes and fail-closes.
    expect(okCount).toBe(1);
    expect(errCount).toBe(1);
    const r = await readFileTool(ws, { path: 'g.txt' });
    expect(['X bar', 'Y bar']).toContain(r.content);
  });

  it('serializes concurrent same-path write_file', async () => {
    const ws = await mkWorkspace();
    await Promise.all([
      writeFileTool(ws, { path: 'h.txt', content: 'first', mkdir: false }).catch(
        () => ({ ok: false as const }),
      ),
      writeFileTool(ws, { path: 'h.txt', content: 'second' }).catch(() => ({
        ok: false as const,
      })),
    ]);
    const r = await readFileTool(ws, { path: 'h.txt' });
    expect(['first', 'second']).toContain(r.content);
  });
});

describe('sandbox tools fingerprints + stat', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function mkWorkspace(): Promise<string> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-fp-'));
    return tmp;
  }

  it('read returns mtimeMs/size; truncated still full-file size', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'big.txt', content: 'abcdefghij' });
    const full = await readFileTool(ws, { path: 'big.txt' });
    expect(full.size).toBe(10);
    expect(Number.isInteger(full.mtimeMs)).toBe(true);

    const r = await readFileTool(ws, { path: 'big.txt', maxBytes: 4 });
    expect(r.content).toBe('abcd');
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(10);
    expect(Number.isInteger(r.mtimeMs)).toBe(true);
  });

  it('write and str_replace return post-write fingerprint', async () => {
    const ws = await mkWorkspace();
    const w = await writeFileTool(ws, { path: 'a.ts', content: 'const x = 1;\n' });
    expect(w.bytes).toBe(Buffer.byteLength('const x = 1;\n'));
    expect(w.size).toBe(w.bytes);
    expect(Number.isInteger(w.mtimeMs)).toBe(true);

    const s = await strReplaceTool(ws, {
      path: 'a.ts',
      old_string: '1',
      new_string: '2',
    });
    expect(s.ok).toBe(true);
    expect(s.replacements).toBe(1);
    expect(s.size).toBe(s.bytes);
    expect(Number.isInteger(s.mtimeMs)).toBe(true);
  });

  it('stat file / dir / 404 / empty path / jail escape', async () => {
    const ws = await mkWorkspace();
    await writeFileTool(ws, { path: 'f.txt', content: 'hi' });
    await fs.mkdir(path.join(ws, 'subdir'));

    const fileSt = await statTool(ws, { path: 'f.txt' });
    expect(fileSt).toMatchObject({ path: 'f.txt', type: 'file', size: 2 });
    expect(Number.isInteger(fileSt.mtimeMs)).toBe(true);

    const dirSt = await statTool(ws, { path: 'subdir' });
    expect(dirSt).toMatchObject({ path: 'subdir', type: 'dir' });
    expect(Number.isInteger(dirSt.mtimeMs)).toBe(true);

    await expect(statTool(ws, { path: 'missing.txt' })).rejects.toMatchObject({
      name: 'ToolError',
      status: 404,
    });
    await expect(statTool(ws, { path: '' })).rejects.toMatchObject({
      name: 'ToolError',
      status: 400,
    });
    await expect(statTool(ws, {})).rejects.toMatchObject({
      name: 'ToolError',
      status: 400,
    });
    await expect(statTool(ws, { path: '../escape' })).rejects.toThrow(JailError);
  });
});
