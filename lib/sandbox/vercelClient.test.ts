import { describe, expect, it, vi } from 'vitest';
import {
  createVercelSandboxClient,
  DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS,
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  resolveVercelFsPath,
  VERCEL_FS_WORKSPACE_ROOT,
  type CreateVercelFsSandboxFn,
  type CreateVercelFsSandboxParams,
  type VercelFsDirentLike,
  type VercelFsSandboxLike,
} from './vercelClient';
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
    const createSandbox: CreateVercelFsSandboxFn = vi.fn(async () => sb);
    const client = createVercelSandboxClient({ createSandbox });

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
      'echo',
      ['x'],
      expect.objectContaining({
        cwd: VERCEL_FS_WORKSPACE_ROOT,
      }),
    );
    // No env secrets on runCommand when execEnv unset
    const runOpts = vi.mocked(sb.runCommand).mock.calls[0]?.[2];
    expect(runOpts?.env).toBeUndefined();

    await client.close?.();
  });

  it('exec passes allowlisted execEnv to runCommand', async () => {
    const sb = mockSandbox();
    const createSandbox: CreateVercelFsSandboxFn = vi.fn(async () => sb);
    const client = createVercelSandboxClient({
      createSandbox,
      execEnv: {
        GH_TOKEN: 'ghp_pat',
        GITHUB_TOKEN: 'ghp_pat',
        PATH: '/should-not-pass',
      },
    });
    await client.exec({ cmd: 'gh', args: ['auth', 'status'] });
    const runOpts = vi.mocked(sb.runCommand).mock.calls[0]?.[2];
    expect(runOpts?.env).toEqual({
      GH_TOKEN: 'ghp_pat',
      GITHUB_TOKEN: 'ghp_pat',
    });
    await client.close?.();
  });

  it('create uses default image when opts.image empty/null', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    for (const image of [null, undefined, '', '   '] as const) {
      createSandbox.mockClear();
      const client = createVercelSandboxClient({
        image: image as string | null | undefined,
        createSandbox,
      });
      await client.listDir('.');
      expect(createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          image: DEFAULT_VERCEL_SANDBOX_IMAGE,
          networkPolicy: 'allow-all',
          persistent: false,
          timeout: DEFAULT_VERCEL_FS_SANDBOX_TIMEOUT_MS,
        }),
      );
      await client.close?.();
    }
  });

  it('create uses custom image when provided', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({
      image: 'vercel/sandbox/node:24',
      createSandbox,
    });
    await client.listDir('.');
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'vercel/sandbox/node:24',
        networkPolicy: 'allow-all',
        persistent: false,
      }),
    );
    await client.close?.();
  });

  it('create always passes timeout + networkPolicy + persistent:false', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({
      createSandbox,
      sandboxTimeoutMs: 12_000,
    });
    await client.listDir('.');
    const params = createSandbox.mock.calls[0]?.[0] as CreateVercelFsSandboxParams;
    expect(params).toEqual({
      image: DEFAULT_VERCEL_SANDBOX_IMAGE,
      timeout: 12_000,
      networkPolicy: 'allow-all',
      persistent: false,
      signal: undefined,
    });
    // Never pass create env secrets
    expect('env' in params).toBe(false);
    await client.close?.();
  });

  it('invalid image shape throws before create (create not called)', () => {
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => mockSandbox());
    expect(() =>
      createVercelSandboxClient({
        image: 'bad image with spaces',
        createSandbox,
      }),
    ).toThrow(SandboxHttpError);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('strReplace unique / multi / replace_all / not found / empty old', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({ createSandbox });

    await client.writeFile('a.ts', 'const x = 1;\n', true);
    await expect(
      client.strReplace('a.ts', 'const x = 1;', 'const x = 2;'),
    ).resolves.toMatchObject({ ok: true, replacements: 1 });
    await expect(client.readFile('a.ts')).resolves.toEqual({
      content: 'const x = 2;\n',
    });

    await client.writeFile('b.ts', 'aa aa aa', true);
    await expect(client.strReplace('b.ts', 'aa', 'bb')).rejects.toThrow(/matched 3 times/i);
    await expect(
      client.strReplace('b.ts', 'aa', 'bb', true),
    ).resolves.toMatchObject({ ok: true, replacements: 3 });
    await expect(client.readFile('b.ts')).resolves.toEqual({ content: 'bb bb bb' });

    await client.writeFile('c.ts', 'hello', true);
    await expect(client.strReplace('c.ts', 'nope', 'x')).rejects.toThrow(/not found/i);
    await expect(client.strReplace('c.ts', '', 'x')).rejects.toThrow(/non-empty/i);

    await client.close?.();
  });

  it('path escape rejected on tools', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({ createSandbox });

    await expect(client.readFile('../etc/passwd')).rejects.toBeInstanceOf(SandboxHttpError);
    await expect(client.readFile('/etc/passwd')).rejects.toBeInstanceOf(SandboxHttpError);
    await expect(
      client.exec({ cmd: 'ls', cwd: '../' }),
    ).rejects.toBeInstanceOf(SandboxHttpError);
    // Path is checked before ensureSandbox
    expect(createSandbox).not.toHaveBeenCalled();

    await client.close?.();
  });

  it('close → stop; second close idempotent; close during create still stops', async () => {
    const sb = mockSandbox();
    let resolveCreate!: (s: VercelFsSandboxLike) => void;
    const gate = new Promise<VercelFsSandboxLike>((r) => {
      resolveCreate = r;
    });
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => gate);
    const client = createVercelSandboxClient({ createSandbox });

    const listP = client.listDir('.');
    const closeP = client.close?.() ?? Promise.resolve();
    resolveCreate(sb);
    await expect(listP).rejects.toThrow(/closed/i);
    await closeP;
    await client.close?.();
    expect(sb.stop).toHaveBeenCalledTimes(1);
  });

  it('close after tools stops once', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({ createSandbox });
    await client.listDir('.');
    await client.close?.();
    await client.close?.();
    expect(sb.stop).toHaveBeenCalledTimes(1);
  });

  it('no secret env on create params', async () => {
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async (params) => {
      expect(params).not.toHaveProperty('env');
      const json = JSON.stringify(params);
      expect(json).not.toMatch(/AI_GATEWAY|SANDBOX_TOKEN|Bearer /i);
      return sb;
    });
    const client = createVercelSandboxClient({ createSandbox });
    await client.listDir('.');
    await client.close?.();
  });

  it('single-flight: concurrent tool calls share one create', async () => {
    let createCount = 0;
    let resolveCreate!: (s: VercelFsSandboxLike) => void;
    const gate = new Promise<VercelFsSandboxLike>((r) => {
      resolveCreate = r;
    });
    const sb = mockSandbox();
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => {
      createCount += 1;
      return gate;
    });
    const client = createVercelSandboxClient({ createSandbox });
    const p1 = client.writeFile('a.txt', '1', true);
    const p2 = client.writeFile('b.txt', '2', true);
    expect(createCount).toBe(1);
    resolveCreate(sb);
    await Promise.all([p1, p2]);
    expect(createCount).toBe(1);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    await client.close?.();
  });

  it('mkdir failure stops VM, clears latch, and allows retry', async () => {
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
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => {
      n += 1;
      return n === 1 ? sbFail : sbOk;
    });
    const client = createVercelSandboxClient({ createSandbox });

    await expect(client.listDir('.')).rejects.toThrow(/ENOSPC|space|failed/i);
    expect(sbFail.stop).toHaveBeenCalledTimes(1);

    await expect(client.listDir('.')).resolves.toMatchObject({ entries: expect.any(Array) });
    expect(createSandbox).toHaveBeenCalledTimes(2);
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
      const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
      const client = createVercelSandboxClient({ createSandbox });
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
    const createSandbox = vi.fn<CreateVercelFsSandboxFn>(async () => sb);
    const client = createVercelSandboxClient({ createSandbox });
    await client.writeFile('a.txt', 'hi', true);

    await expect(client.readFile('.')).rejects.toThrow(/not a file/i);
    await expect(client.listDir('a.txt')).rejects.toThrow(/not a directory/i);
    await client.close?.();
  });
});
