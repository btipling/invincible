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
    expect(w).toEqual({ ok: true, bytes: Buffer.byteLength('hello world') });

    const r = await readFileTool(ws, { path: 'hello.txt' });
    expect(r.content).toBe('hello world');
    expect(r.truncated).toBeUndefined();

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
});
