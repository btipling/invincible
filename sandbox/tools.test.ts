import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STDIO_BYTES } from './constants.mjs';
import { JailError } from './paths.mjs';
import {
  execCmd,
  listDir,
  readFileTool,
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
});
