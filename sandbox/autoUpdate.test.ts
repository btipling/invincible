import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => (spawnMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

// Import AFTER the mock so `autoUpdate.mjs` sees the mocked spawn.
import { attemptAutoUpdate, resolveAutoUpdateConfig } from './autoUpdate.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChildLike = any;

/** Fake git child that yields output then closes on the next tick. */
function fakeChild(code: number, stdout = '', stderr = '', errorMsg = ''): ChildLike {
  const dataOut: Handler[] = [];
  const dataErr: Handler[] = [];
  const onClose: Handler[] = [];
  const onError: Handler[] = [];
  const child: ChildLike = {
    stdout: {
      on: (_ev: string, fn: Handler) => {
        dataOut.push(fn);
        return child;
      },
    },
    stderr: {
      on: (_ev: string, fn: Handler) => {
        dataErr.push(fn);
        return child;
      },
    },
    on: (ev: string, fn: Handler) => {
      if (ev === 'close') onClose.push(fn);
      if (ev === 'error') onError.push(fn);
      return child;
    },
  };
  process.nextTick(() => {
    if (errorMsg) {
      for (const fn of onError) fn(new Error(errorMsg));
      return;
    }
    for (const fn of dataOut) fn(Buffer.from(stdout));
    for (const fn of dataErr) fn(Buffer.from(stderr));
    for (const fn of onClose) fn(code);
  });
  return child;
}

/** Wire spawnMock to a queue of git subcommand responses. */
function mockGit(
  plan: Record<string, (...args: unknown[]) => ChildLike>,
): ReturnType<typeof vi.fn> {
  let revParses = 0;
  const fn = vi.fn(
    (_cmd: string, args: string[], _opts: Record<string, unknown>): ChildLike => {
      const sub = args[0];
      if (sub === 'fetch') return plan.fetch?.() ?? fakeChild(0);
      if (sub === 'merge') return plan.merge?.() ?? fakeChild(0);
      if (sub === 'rev-parse') {
        revParses += 1;
        if (plan['rev-parse']) return plan['rev-parse'](revParses);
        return fakeChild(0);
      }
      return fakeChild(0);
    },
  );
  spawnMock.mockImplementation(fn as never);
  return fn;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('resolveAutoUpdateConfig', () => {
  it('is disabled by default (no git requirement for static/BYO hosts)', () => {
    const cfg = resolveAutoUpdateConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.gitDir).toBeNull();
    expect(cfg.ref).toBe('origin/main');
    expect(cfg.intervalMs).toBe(60_000);
  });

  it('enables only when both SANDBOX_AUTO_UPDATE and SANDBOX_GIT_DIR are set', () => {
    expect(resolveAutoUpdateConfig({ SANDBOX_AUTO_UPDATE: '1' }).gitDir).toBeNull();
    const on = resolveAutoUpdateConfig({
      SANDBOX_AUTO_UPDATE: '1',
      SANDBOX_GIT_DIR: '/srv/invincible',
    });
    expect(on.enabled).toBe(true);
    expect(on.gitDir).toBe('/srv/invincible');
  });
});

describe('attemptAutoUpdate', () => {
  it('disabled config never invokes git', async () => {
    await attemptAutoUpdate({ enabled: false, gitDir: null, ref: 'origin/main' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no git dir → early no-op', async () => {
    const res = await attemptAutoUpdate({ enabled: true, gitDir: null, ref: 'origin/main' });
    expect(res).toEqual({ updated: false, reason: 'no-git-dir' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns updated=true when ff-only merge advances HEAD', async () => {
    mockGit({
      fetch: () => fakeChild(0),
      merge: () => fakeChild(0),
      'rev-parse': (n) => (n === 1 ? fakeChild(0, 'aaaa\n') : fakeChild(0, 'bbbb\n')),
    });
    const res = await attemptAutoUpdate({
      enabled: true,
      gitDir: '/srv/invincible',
      ref: 'origin/main',
    });
    expect(res).toEqual({ updated: true });
    // Full argv-only sequence, never a shell.
    expect(spawnMock).toHaveBeenCalledTimes(4);
    const mergeArgs = spawnMock.mock.calls.find((c) => c[1][0] === 'merge');
    expect(mergeArgs?.[1].slice(1)).toEqual(['--ff-only', 'origin/main']);
  });

  it('fetch failure → no exit, update false', async () => {
    mockGit({ fetch: () => fakeChild(1, '', 'fatal: could not read') });
    const res = await attemptAutoUpdate({
      enabled: true,
      gitDir: '/srv/invincible',
      ref: 'origin/main',
    });
    expect(res.updated).toBe(false);
    expect(res.reason).toBe('fetch-failed');
  });

  it('ff-only merge failure (divergent) → no exit, update false', async () => {
    mockGit({
      fetch: () => fakeChild(0),
      merge: () => fakeChild(1, '', 'fatal: Not possible to fast-forward'),
      'rev-parse': () => fakeChild(0, 'aaaa\n'),
    });
    const res = await attemptAutoUpdate({
      enabled: true,
      gitDir: '/srv/invincible',
      ref: 'origin/main',
    });
    expect(res.updated).toBe(false);
    expect(res.reason).toBe('merge-failed');
  });

  it('merge no-op (already current) → updated false', async () => {
    mockGit({
      fetch: () => fakeChild(0),
      merge: () => fakeChild(0),
      'rev-parse': () => fakeChild(0, 'same\n'),
    });
    const res = await attemptAutoUpdate({
      enabled: true,
      gitDir: '/srv/invincible',
      ref: 'origin/main',
    });
    expect(res).toEqual({ updated: false });
  });

  it('git binary missing → soft failure, no throw', async () => {
    mockGit({
      fetch: () => fakeChild(0, '', '', 'git not found'),
    });
    const res = await attemptAutoUpdate({
      enabled: true,
      gitDir: '/srv/invincible',
      ref: 'origin/main',
    });
    expect(res.updated).toBe(false);
    expect(res.reason).toBe('fetch-failed');
  });
});
