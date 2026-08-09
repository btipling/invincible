import { describe, expect, it, vi } from 'vitest';
import {
  createVercelSandboxClient,
  DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS,
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  resolveVercelFsPath,
  VERCEL_FS_WORKSPACE_ROOT,
  type GetVercelFsSandboxFn,
  type GetVercelFsSandboxParams,
  type VercelFsDirentLike,
  type VercelFsSandboxLike,
} from './vercelClient';
import { USER_SANDBOX_IDLE_TIMEOUT_MS } from '../tenancy/userSandboxInstance';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxHttpError } from './types';

function dirent(name: string, kind: 'file' | 'dir' | 'other'): VercelFsDirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function mockSandbox(overrides: Partial<VercelFsSandboxLike> = {}): VercelFsSandboxLike {
  const files = new Map<string, string>();
  const dirs = new Set<string>([VERCEL_FS_WORKSPACE_ROOT]);
  const { fs: fsOverrides, ...restOverrides } = overrides;

  const base: VercelFsSandboxLike = {
    fs: {
      readdir: vi.fn(async (dirPath: string) => {
        const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
        const names = new Map<string, 'file' | 'dir'>();
        for (const d of dirs) {
          if (d.startsWith(prefix)) {
            const rest = d.slice(prefix.length);
            const name = rest.split('/')[0];
            if (name) names.set(name, 'dir');
          }
        }
        for (const f of files.keys()) {
          if (f.startsWith(prefix)) {
            const rest = f.slice(prefix.length);
            const name = rest.split('/')[0];
            if (name && !names.has(name)) names.set(name, 'file');
          }
        }
        return [...names.entries()].map(([name, kind]) => dirent(name, kind));
      }),
      readFile: vi.fn(async (filePath: string) => {
        if (!files.has(filePath)) {
          const err = new Error(`ENOENT: ${filePath}`);
          throw err;
        }
        return files.get(filePath)!;
      }),
      writeFile: vi.fn(async (filePath: string, data: string | Buffer) => {
        files.set(filePath, typeof data === 'string' ? data : data.toString('utf8'));
      }),
      mkdir: vi.fn(async (dirPath: string) => {
        dirs.add(dirPath);
      }),
      stat: vi.fn(async (filePath: string) => {
        if (dirs.has(filePath)) {
          return {
            isFile: () => false,
            isDirectory: () => true,
            size: 0,
          };
        }
        if (files.has(filePath)) {
          const content = files.get(filePath)!;
          return {
            isFile: () => true,
            isDirectory: () => false,
            size: Buffer.byteLength(content, 'utf8'),
          };
        }
        throw new Error(`ENOENT: ${filePath}`);
      }),
      ...fsOverrides,
    },
    runCommand: vi.fn(async (cmd: string, args?: string[]) => {
      if (cmd === 'head' && args?.[0] === '-c' && args[2]) {
        const filePath = args[2];
        const max = Number(args[1]);
        const content = files.get(filePath) ?? '';
        const buf = Buffer.from(content, 'utf8');
        return {
          exitCode: 0,
          stdout: buf.subarray(0, max).toString('utf8'),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      };
    }),
    stop: vi.fn(async () => ({})),
    extendTimeout: vi.fn(async () => ({})),
    ...restOverrides,
  };

  return base;
}

describe('resolveVercelFsPath', () => {
  it('maps . to workspace root', () => {
    expect(resolveVercelFsPath(VERCEL_FS_WORKSPACE_ROOT, '.')).toBe(
      VERCEL_FS_WORKSPACE_ROOT,
    );
  });

  it('joins relative paths under root', () => {
    expect(resolveVercelFsPath(VERCEL_FS_WORKSPACE_ROOT, 'src/a.ts')).toBe(
      `${VERCEL_FS_WORKSPACE_ROOT}/src/a.ts`,
    );
  });

  it('rejects host-absolute and .. escape', () => {
    expect(() => resolveVercelFsPath(VERCEL_FS_WORKSPACE_ROOT, '/etc/passwd')).toThrow(
      /absolute|escape/i,
    );
    expect(() => resolveVercelFsPath(VERCEL_FS_WORKSPACE_ROOT, '../outside')).toThrow(
      /escape/i,
    );
  });
});

describe('createVercelSandboxClient', () => {
  it('tools happy path: list/read/write/exec', async () => {
    const sb = mockSandbox();
    const createSandbox: GetVercelFsSandboxFn = vi.fn(async () => sb);
    const client = createVercelSandboxClient({ name: 'inv-workspace-test', getSandbox: createSandbox });

    await client.writeFile('hello.txt', 'hi', true);
    await expect(client.readFile('hello.txt')).resolves.toEqual({ content: 'hi' });
    await expect(client.listDir('.')).resolves.toMatchObject({
      entries: expect.arrayContaining([{ name: 'hello.txt', type: 'file' }]),
    });
    await expect(client.exec({ cmd: 'echo', args: ['x'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(sb.fs.mkdir).toHaveBeenCalledWith(
      VERCEL_FS_WORKSPACE_ROOT,
      expect.objectContaining({ recursive: true }),
    );
    expect(sb.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: 'echo',
        args: ['x'],
        cwd: VERCEL_FS_WORKSPACE_ROOT,
      }),
    );
    // Object form; no env when execEnv unset (SDK 3-arg would drop cwd/env)
    const runParams = vi.mocked(sb.runCommand).mock.calls[0]?.[0] as {
      env?: Record<string, string>;
    };
    expect(runParams.env).toBeUndefined();

    await client.close?.();
  });

  it('exec passes allowlisted execEnv to runCommand', async () => {
    const sb = mockSandbox();
    const createSandbox: GetVercelFsSandboxFn = vi.fn(async () => sb);
    const client = createVercelSandboxClient({
      name: 'inv-workspace-test',
      getSandbox: createSandbox,
      execEnv: {
        GH_TOKEN: 'ghp_pat',
        GITHUB_TOKEN: 'ghp_pat',
        PATH: '/should-not-pass',
      },
    });
    await client.exec({ cmd: 'gh', args: ['auth', 'status'] });
    const runParams = vi.mocked(sb.runCommand).mock.calls[0]?.[0] as {
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
    };
    expect(runParams).toEqual(
      expect.objectContaining({
        cmd: 'gh',
        args: ['auth', 'status'],
        env: {
          GH_TOKEN: 'ghp_pat',
          GITHUB_TOKEN: 'ghp_pat',
        },
      }),
    );
    // Must be object form — string+opts would drop env in real SDK
    expect(typeof vi.mocked(sb.runCommand).mock.calls[0]?.[0]).toBe('object');
    await client.close?.();
  });

  it('get called with name + resume:true; never create-shaped params', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({
      name: 'inv-workspace-abc',
      getSandbox,
    });
    await client.listDir('.');
    expect(getSandbox).toHaveBeenCalledWith({
      name: 'inv-workspace-abc',
      resume: true,
      signal: undefined,
    });
    const params = getSandbox.mock.calls[0]?.[0] as GetVercelFsSandboxParams;
    expect(params).not.toHaveProperty('image');
    expect(params).not.toHaveProperty('persistent');
    expect(params).not.toHaveProperty('timeout');
    expect(params).not.toHaveProperty('env');
    await client.close?.();
  });

  it('empty name throws before get', () => {
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => mockSandbox());
    expect(() =>
      createVercelSandboxClient({ name: '  ', getSandbox }),
    ).toThrow(SandboxHttpError);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('invalid image shape throws before get when image provided', () => {
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => mockSandbox());
    expect(() =>
      createVercelSandboxClient({
        name: 'inv-workspace-test',
        image: 'bad image with spaces',
        getSandbox,
      }),
    ).toThrow(SandboxHttpError);
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it('null/empty image allowed (attach does not create)', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
    for (const image of [null, '', undefined] as const) {
      getSandbox.mockClear();
      const client = createVercelSandboxClient({
        name: 'inv-workspace-test',
        ...(image !== undefined ? { image: image as string | null } : {}),
        getSandbox,
      });
      await client.listDir('.');
      expect(getSandbox).toHaveBeenCalledTimes(1);
      await client.close?.();
    }
  });

  it('attach extends timeout on get; close extends again and never stops', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({
      name: 'inv-workspace-test',
      getSandbox,
      idleTimeoutMs: 60_000,
    });
    await client.listDir('.');
    expect(sb.extendTimeout).toBeDefined();
    const extend = vi.mocked(sb.extendTimeout!);
    expect(extend).toHaveBeenCalledWith(60_000);
    const afterAttach = extend.mock.calls.length;
    await client.close?.();
    await client.close?.();
    expect(extend.mock.calls.length).toBeGreaterThan(afterAttach);
    expect(sb.stop).not.toHaveBeenCalled();
  });

  it('close during attach does not stop VM', async () => {
    const sb = mockSandbox();
    let resolveGet!: (s: VercelFsSandboxLike) => void;
    const gate = new Promise<VercelFsSandboxLike>((r) => {
      resolveGet = r;
    });
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => gate);
    const client = createVercelSandboxClient({
      name: 'inv-workspace-test',
      getSandbox,
    });

    const listP = client.listDir('.');
    const closeP = client.close?.() ?? Promise.resolve();
    resolveGet(sb);
    await expect(listP).rejects.toThrow(/closed/i);
    await closeP;
    await client.close?.();
    expect(sb.stop).not.toHaveBeenCalled();
  });

  it('default idle timeout is 30m family', async () => {
    const sb = mockSandbox();
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({
      name: 'inv-workspace-test',
      getSandbox,
    });
    await client.listDir('.');
    expect(sb.extendTimeout).toBeDefined();
    expect(vi.mocked(sb.extendTimeout!)).toHaveBeenCalledWith(
      DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS,
    );
    expect(DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS).toBe(USER_SANDBOX_IDLE_TIMEOUT_MS);
    await client.close?.();
  });

  it('no secret env on get params', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<GetVercelFsSandboxFn>(async (params) => {
      expect(params).not.toHaveProperty('env');
      const json = JSON.stringify(params);
      expect(json).not.toMatch(/AI_GATEWAY|SANDBOX_TOKEN|Bearer /i);
      return sb;
    });
    const client = createVercelSandboxClient({ name: 'inv-workspace-test', getSandbox: createSandbox });
    await client.listDir('.');
    await client.close?.();
  });

  it('single-flight: concurrent tool calls share one get', async () => {
    let createCount = 0;
    let resolveCreate!: (s: VercelFsSandboxLike) => void;
    const gate = new Promise<VercelFsSandboxLike>((r) => {
      resolveCreate = r;
    });
    const sb = mockSandbox();
    const createSandbox = vi.fn<GetVercelFsSandboxFn>(async () => {
      createCount += 1;
      return gate;
    });
    const client = createVercelSandboxClient({ name: 'inv-workspace-test', getSandbox: createSandbox });
    const p1 = client.writeFile('a.txt', '1', true);
    const p2 = client.writeFile('b.txt', '2', true);
    expect(createCount).toBe(1);
    resolveCreate(sb);
    await Promise.all([p1, p2]);
    expect(createCount).toBe(1);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    await client.close?.();
  });

  it('mkdir failure does not stop VM; clears latch; allows retry get', async () => {
    const sbFail = mockSandbox({
      fs: {
        readdir: vi.fn(async () => []),
        readFile: vi.fn(async () => ''),
        writeFile: vi.fn(async () => {}),
        mkdir: vi.fn(async () => {
          throw new Error('ENOSPC: no space left');
        }),
        stat: vi.fn(async () => ({
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
        })),
      },
    });
    const sbOk = mockSandbox();
    let n = 0;
    const getSandbox = vi.fn<GetVercelFsSandboxFn>(async () => {
      n += 1;
      return n === 1 ? sbFail : sbOk;
    });
    const client = createVercelSandboxClient({
      name: 'inv-workspace-test',
      getSandbox,
    });

    await expect(client.listDir('.')).rejects.toThrow(/ENOSPC|space|failed/i);
    expect(sbFail.stop).not.toHaveBeenCalled();

    await expect(client.listDir('.')).resolves.toMatchObject({ entries: expect.any(Array) });
    expect(getSandbox).toHaveBeenCalledTimes(2);
    await client.close?.();
  });

  it('readFile uses stat size gate + byte truncate (not full multi-GB load path)', async () => {
    const big = 'x'.repeat(100);
    const sb = mockSandbox();
    // Pretend file is huge so readFile takes the head -c path.
    sb.fs.stat = vi.fn(async () => ({
      isFile: () => true,
      isDirectory: () => false,
      size: 50_000_000,
    }));
    // Seed content for head path
    await (async () => {
      const createSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
      const client = createVercelSandboxClient({ name: 'inv-workspace-test', getSandbox: createSandbox });
      // write via underlying map through writeFile (size not used when we override stat)
      await client.writeFile('big.txt', big, true);
      // Override stat after write so size stays huge
      sb.fs.stat = vi.fn(async () => ({
        isFile: () => true,
        isDirectory: () => false,
        size: 50_000_000,
      }));
      const res = await client.readFile('big.txt', 10);
      expect(res.truncated).toBe(true);
      expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(10);
      expect(sb.fs.readFile).not.toHaveBeenCalledWith(
        expect.stringContaining('big.txt'),
        expect.anything(),
      );
      // head path used
      expect(sb.runCommand).toHaveBeenCalledWith(
        'head',
        expect.arrayContaining(['-c', '11']),
        expect.anything(),
      );
      await client.close?.();
    })();
  });

  it('readFile rejects directories; listDir rejects files', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<GetVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({ name: 'inv-workspace-test', getSandbox: createSandbox });
    await client.writeFile('a.txt', 'hi', true);

    await expect(client.readFile('.')).rejects.toThrow(/not a file/i);
    await expect(client.listDir('a.txt')).rejects.toThrow(/not a directory/i);
    await client.close?.();
  });

  it('product source has no Sandbox.create / getOrCreate call / stop-on-close path', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcText = readFileSync(join(here, 'vercelClient.ts'), 'utf8');
    expect(srcText).not.toMatch(/Sandbox\.create\s*\(/);
    expect(srcText).not.toMatch(/\.getOrCreate\s*\(/);
    expect(srcText).not.toMatch(/Sandbox\.getOrCreate\s*\(/);
    // close path must not call stop
    expect(srcText).not.toMatch(/await sb\.stop\(/);
    expect(srcText).not.toMatch(/await sb\?\.stop\(/);
  });

});
