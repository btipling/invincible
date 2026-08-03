import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JailError, resolveJailPath } from './paths.mjs';

describe('resolveJailPath', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function mkWorkspace(): Promise<string> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-jail-'));
    return tmp;
  }

  it('maps . and empty to workspace root', async () => {
    const ws = await mkWorkspace();
    expect(resolveJailPath(ws, '.')).toBe(path.resolve(ws));
    expect(resolveJailPath(ws, '')).toBe(path.resolve(ws));
    expect(resolveJailPath(ws, undefined)).toBe(path.resolve(ws));
  });

  it('resolves nested relative paths', async () => {
    const ws = await mkWorkspace();
    const nested = resolveJailPath(ws, 'a/b/c.txt');
    expect(nested).toBe(path.join(path.resolve(ws), 'a', 'b', 'c.txt'));
  });

  it('rejects .. escape above workspace', async () => {
    const ws = await mkWorkspace();
    expect(() => resolveJailPath(ws, '..')).toThrow(JailError);
    expect(() => resolveJailPath(ws, '../outside')).toThrow(JailError);
    expect(() => resolveJailPath(ws, 'foo/../../..')).toThrow(JailError);
  });

  it('rejects absolute paths outside workspace', async () => {
    const ws = await mkWorkspace();
    expect(() => resolveJailPath(ws, '/etc/passwd')).toThrow(JailError);
    expect(() => resolveJailPath(ws, os.tmpdir())).toThrow(JailError);
  });

  it('allows absolute path that is exactly the workspace', async () => {
    const ws = await mkWorkspace();
    const abs = path.resolve(ws);
    expect(resolveJailPath(ws, abs)).toBe(abs);
  });

  it('allows absolute path inside workspace', async () => {
    const ws = await mkWorkspace();
    const abs = path.join(path.resolve(ws), 'inside.txt');
    expect(resolveJailPath(ws, abs)).toBe(abs);
  });

  it('rejects null byte', async () => {
    const ws = await mkWorkspace();
    expect(() => resolveJailPath(ws, 'foo\0bar')).toThrow(JailError);
  });
});
